import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { spawn, type ChildProcess } from "node:child_process";
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
};
type Managed = {
  session: Session;
  child: ChildProcess;
  timer: ReturnType<typeof setInterval>;
  release: () => void;
  token: string;
};
const sessions = new Map<string, Managed>();
const pending = new Map<string, Promise<Session>>();
const installs = new Map<string, Promise<string>>();
const ports = () =>
  [...sessions.values()]
    .filter((s) => s.session.url.startsWith("https:"))
    .map((s) => s.session.port);

async function stop(key: string) {
  const m = sessions.get(key);
  if (!m) return false;
  sessions.delete(key);
  clearInterval(m.timer);
  // px0 supervises its LSP children; SIGTERM gives it time to close them.
  const done = new Promise<void>((resolve) =>
    m.child.once("exit", () => resolve()),
  );
  m.child.kill("SIGTERM");
  await Promise.race([
    done,
    new Promise<void>((resolve) => setTimeout(resolve, 1800)),
  ]);
  if (m.child.exitCode === null && m.child.signalCode === null)
    m.child.kill("SIGKILL");
  m.release();
  return true;
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
      const existing = sessions.get(input.key);
      const root = await realpath(input.root);
      if (!isAbsolute(root) || (await stat(root)).isDirectory() !== true)
        throw new Error("Review requires an existing workspace directory");
      if (
        existing &&
        existing.session.root === root &&
        existing.child.exitCode === null &&
        existing.child.signalCode === null
      ) {
        existing.session.lastUsed = Date.now();
        return existing.session;
      }
      if (existing) await stop(input.key);
      const inFlight = pending.get(input.key);
      if (inFlight) return inFlight;
      const task = (async () => {
        const executable = await binary(
          ctx.experimental_paths.dataDir,
          input.binaryPath,
        );
        if (ctx.signal.aborted) throw new Error("Review launch cancelled");
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
        const abort = () => {
          child.kill("SIGTERM");
        };
        ctx.signal.addEventListener("abort", abort, { once: true });
        ctx.lifecycle.signal.addEventListener("abort", abort, { once: true });
        try {
          let ready = false;
          for (let i = 0; i < 100; i++) {
            if (ctx.signal.aborted || ctx.lifecycle.signal.aborted)
              throw new Error("Review launch cancelled");
            if (spawnError) throw spawnError;
            if (child.exitCode !== null || child.signalCode !== null)
              throw new Error(`px0 exited: ${log}`);
            try {
              const response = await fetch(
                `http://127.0.0.1:${port}/api/meta`,
                {
                  headers: { Authorization: `Bearer ${token}` },
                  signal: AbortSignal.timeout(400),
                },
              );
              if (response.ok) {
                const meta = (await response.json()) as {
                  root?: string;
                  embedOrigin?: string;
                };
                if (meta.root === root && meta.embedOrigin === input.origin) {
                  ready = true;
                  break;
                }
              }
            } catch {}
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
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
          };
          const lease = ctx.experimental_retainWorker();
          const releaseWorker = () => {
            ctx.lifecycle.signal.removeEventListener("abort", abort);
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
          ctx.lifecycle.signal.removeEventListener("abort", abort);
          child.kill("SIGTERM");
          throw e;
        } finally {
          ctx.signal.removeEventListener("abort", abort);
        }
      })();
      pending.set(input.key, task);
      try {
        return await task;
      } finally {
        pending.delete(input.key);
      }
    },
    async stop({ threadId }) {
      let stopped = 0;
      for (const [key, m] of sessions)
        if (m.session.threadId === threadId && (await stop(key))) stopped++;
      return { stopped };
    },
    async status() {
      return { sessions: [...sessions.values()].map((m) => m.session) };
    },
  },
  dispose: async () => {
    await Promise.all([...sessions.keys()].map(stop));
  },
});
