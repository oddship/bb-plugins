import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  chmod,
  realpath,
  stat,
} from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { hostContract, hostSignals } from "./contract";
import release from "./release.json";

type Session = {
  key: string;
  threadId: string;
  root: string;
  port: number;
  url: string;
  pid: number;
  lastUsed: number;
  fileCount: number | null;
};
type Managed = {
  session: Session;
  child: ChildProcess;
  timer: ReturnType<typeof setInterval>;
  release: () => void;
  token: string;
};
const sessions = new Map<string, Managed>();
const pending = new Map<
  string,
  {
    threadId: string;
    controller: AbortController;
    task: Promise<Session>;
  }
>();
const installs = new Map<string, Promise<string>>();
const ports = () =>
  [...sessions.values()]
    .filter((s) => s.session.url.startsWith("https:"))
    .map((s) => s.session.port);

type WorkspaceMeta = {
  root?: string;
  embedOrigin?: string;
  ready?: boolean;
  files?: number;
};
function indexedFileCount(meta: WorkspaceMeta): number | null {
  return meta.ready === true &&
    Number.isSafeInteger(meta.files) &&
    meta.files! >= 0
    ? meta.files!
    : null;
}
async function refreshFileCount(managed: Managed) {
  try {
    const response = await fetch(
      `http://127.0.0.1:${managed.session.port}/api/meta`,
      {
        headers: { Authorization: `Bearer ${managed.token}` },
        signal: AbortSignal.timeout(700),
      },
    );
    if (response.ok)
      managed.session.fileCount = indexedFileCount(
        (await response.json()) as WorkspaceMeta,
      );
  } catch {
    /* Preserve the last count during a temporary connection failure. */
  }
}

async function terminate(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  const done = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.kill("SIGTERM");
  // The fork drains HTTP requests for up to two seconds before closing LSPs.
  await Promise.race([done, delay(2500)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await done;
  }
}
async function cancellable<T>(
  task: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    void task.catch(() => {});
    signal.throwIfAborted();
  }
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([task, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
async function stop(key: string) {
  const m = sessions.get(key);
  if (!m) return false;
  sessions.delete(key);
  clearInterval(m.timer);
  await terminate(m.child);
  m.release();
  return true;
}
async function stopThread(threadId?: string) {
  const launches = [...pending.entries()].filter(
    ([, p]) => threadId === undefined || p.threadId === threadId,
  );
  const keys = new Set([
    ...launches.map(([key]) => key),
    ...[...sessions.entries()]
      .filter(
        ([, m]) => threadId === undefined || m.session.threadId === threadId,
      )
      .map(([key]) => key),
  ]);
  for (const [, p] of launches)
    p.controller.abort(new Error("Review launch cancelled"));
  await Promise.allSettled(launches.map(([, p]) => p.task));
  await Promise.all([...keys].map(stop));
  return { stopped: keys.size };
}
async function freePort() {
  const s = createServer();
  await new Promise<void>((resolve, reject) => {
    s.once("error", reject);
    s.listen(0, "127.0.0.1", resolve);
  });
  const addr = s.address();
  if (!addr || typeof addr === "string")
    throw new Error("Cannot allocate review port");
  const port = addr.port;
  await new Promise<void>((resolve, reject) =>
    s.close((e) => (e ? reject(e) : resolve())),
  );
  return port;
}
async function binary(dataDir: string, override: string) {
  if (override) {
    if (!isAbsolute(override))
      throw new Error("Binary override must be absolute");
    await stat(override);
    return override;
  }
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  const asset = `px0-${platform}-${arch}${platform === "windows" ? ".exe" : ""}`;
  const expected = (release.assets as Record<string, string>)[asset];
  if (!expected)
    throw new Error(
      `No verified fork build for ${platform}/${arch}. Configure an absolute fork binary path in px0 Review settings.`,
    );
  const target = join(dataDir, "bin", release.tag, asset);
  let task = installs.get(target);
  if (task) return task;
  task = (async () => {
    try {
      if (
        createHash("sha256")
          .update(await readFile(target))
          .digest("hex") === expected
      )
        return target;
    } catch {}
    await mkdir(join(dataDir, "bin", release.tag), { recursive: true });
    const url = `https://github.com/${release.repository}/releases/download/${release.tag}/${asset}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok)
      throw new Error(`Cannot download fork build: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== expected)
      throw new Error("Fork binary checksum mismatch");
    const temp = target + "." + randomBytes(6).toString("hex");
    await writeFile(temp, bytes, { mode: 0o700 });
    await chmod(temp, 0o700);
    await rename(temp, target);
    return target;
  })();
  installs.set(target, task);
  try {
    return await task;
  } catch (e) {
    installs.delete(target);
    throw e;
  }
}

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    async ensure(input, ctx) {
      const inFlight = pending.get(input.key);
      if (inFlight) return inFlight.task;
      const controller = new AbortController();
      const signal = AbortSignal.any([
        controller.signal,
        ctx.signal,
        ctx.lifecycle.signal,
      ]);
      const task = (async () => {
        const existing = sessions.get(input.key);
        const root = await realpath(input.root);
        signal.throwIfAborted();
        if (!isAbsolute(root) || (await stat(root)).isDirectory() !== true)
          throw new Error("Review requires an existing workspace directory");
        if (
          existing &&
          existing.session.root === root &&
          existing.child.exitCode === null &&
          existing.child.signalCode === null
        ) {
          existing.session.lastUsed = Date.now();
          await refreshFileCount(existing);
          signal.throwIfAborted();
          return existing.session;
        }
        if (existing) await stop(input.key);
        const executable = await cancellable(
          binary(ctx.experimental_paths.dataDir, input.binaryPath),
          signal,
        );
        signal.throwIfAborted();
        const port = await freePort();
        const publicOrigin = input.tunnel
          ? `https://${input.tunnel.label}--${port}.${input.tunnel.baseDomain}`
          : `http://127.0.0.1:${port}`;
        const token = randomBytes(32).toString("hex");
        const state = join(
          ctx.experimental_paths.dataDir,
          "state",
          createHash("sha256").update(input.key).digest("hex").slice(0, 20),
        );
        await mkdir(state, { recursive: true });
        signal.throwIfAborted();
        const child = spawn(
          executable,
          [
            "-host",
            "127.0.0.1",
            "-port",
            String(port),
            "-no-open",
            "-no-update",
            "-no-telemetry",
            "-no-agent",
            "-no-color",
            "-embed-origin",
            input.origin,
            "-public-origin",
            publicOrigin,
            root,
          ],
          {
            cwd: root,
            env: {
              ...process.env,
              PX0_ACCESS_TOKEN: token,
              XDG_CONFIG_HOME: state,
              XDG_STATE_HOME: state,
            },
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          },
        );
        let log = "";
        child.stdout?.on("data", (b) => {
          log = (log + String(b)).slice(-4000);
        });
        child.stderr?.on("data", (b) => {
          log = (log + String(b)).slice(-4000);
        });
        let spawnError: Error | undefined;
        child.on("error", (e) => {
          spawnError = e;
        });
        try {
          let ready = false;
          let fileCount: number | null = null;
          for (let i = 0; i < 100; i++) {
            signal.throwIfAborted();
            if (spawnError) throw spawnError;
            if (child.exitCode !== null || child.signalCode !== null)
              throw new Error(`px0 exited: ${log}`);
            try {
              const response = await fetch(
                `http://127.0.0.1:${port}/api/meta`,
                {
                  headers: { Authorization: `Bearer ${token}` },
                  signal: AbortSignal.any([signal, AbortSignal.timeout(400)]),
                },
              );
              if (response.ok) {
                const meta = (await response.json()) as WorkspaceMeta;
                if (meta.root === root && meta.embedOrigin === input.origin) {
                  fileCount = indexedFileCount(meta);
                  ready = true;
                  break;
                }
              }
            } catch {}
            await delay(100, undefined, { signal });
          }
          signal.throwIfAborted();
          if (!ready)
            throw new Error(
              `px0 did not become ready on its assigned port. ${log}`,
            );
          const session: Session = {
            key: input.key,
            threadId: input.threadId,
            root,
            port,
            url: `${publicOrigin}/?px0_token=${token}`,
            pid: child.pid!,
            lastUsed: Date.now(),
            fileCount,
          };
          const lease = ctx.experimental_retainWorker();
          const releaseWorker = () => {
            lease.dispose();
          };
          const timer = setInterval(() => {
            if (Date.now() - session.lastUsed > 180000)
              void stop(input.key).then(() =>
                ctx.experimental_emitSignal("ports", { ports: ports() }),
              );
          }, 30000);
          timer.unref();
          sessions.set(input.key, {
            session,
            child,
            timer,
            release: releaseWorker,
            token,
          });
          child.once("exit", () => {
            const m = sessions.get(input.key);
            if (m?.child === child) {
              sessions.delete(input.key);
              clearInterval(timer);
              releaseWorker();
              void ctx
                .experimental_emitSignal("ports", { ports: ports() })
                .catch(() => {});
            }
          });
          return session;
        } catch (e) {
          await terminate(child);
          throw e;
        }
      })();
      pending.set(input.key, { threadId: input.threadId, controller, task });
      try {
        return await task;
      } finally {
        pending.delete(input.key);
      }
    },
    async stop({ threadId }) {
      return stopThread(threadId);
    },
    async status() {
      return { sessions: [...sessions.values()].map((m) => m.session) };
    },
  },
  dispose: async () => {
    await stopThread();
  },
});
