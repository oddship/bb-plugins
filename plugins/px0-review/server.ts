import { createHash } from "node:crypto";
import { z } from "zod";
import { cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { hostContract, hostSignals, rpcContract } from "./contract";
export { rpcContract } from "./contract";

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    binaryPath: {
      type: "string",
      label: "Fork binary override (absolute path on the workspace host)",
      default: "",
    },
  });
  const host = bb.hosts.experimental_client({
    contract: hostContract,
    experimental_signals: hostSignals,
  });
  const activeHosts = new Set<string>();
  const opening = new Map<string, Set<AbortController>>();
  const stopping = new Map<string, Promise<{ stopped: number }>>();
  const serverShares = new Map<string, Set<number>>();
  const primaryHosts = new Set<string>();
  const sharingQueues = new Map<string, Promise<void>>();
  async function connectCall<T>(
    method: string,
    input: unknown,
    outputSchema: z.ZodType<T>,
  ): Promise<T> {
    return bb.sdk.plugins.callRpc({
      pluginId: "connect",
      method,
      input: input as never,
      outputSchema,
    });
  }
  async function primaryTunnel(hostId: string) {
    const status = await connectCall(
      "status",
      null,
      z.object({
        paired: z.boolean(),
        enabled: z.boolean(),
        url: z.string().nullable(),
      }),
    );
    if (!status.paired || !status.enabled || !status.url)
      throw new Error(
        "Enable BB Connect remote access to open this review remotely.",
      );
    const url = new URL(status.url);
    const [label, ...domain] = url.hostname.split(".");
    primaryHosts.add(hostId);
    return { label, baseDomain: domain.join(".") };
  }
  async function applyPorts(hostId: string, ports: number[]) {
    if (!primaryHosts.has(hostId)) {
      bb.hosts.declareSharedPorts(hostId, ports);
      return;
    }
    const previous = sharingQueues.get(hostId) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        const current = serverShares.get(hostId) ?? new Set<number>();
        serverShares.set(hostId, current);
        const desired = new Set(ports);
        for (const port of current)
          if (!desired.has(port)) {
            await connectCall(
              "unexpose",
              { hostId, port },
              z.object({ removed: z.boolean() }),
            );
            current.delete(port);
          }
        for (const port of desired)
          if (!current.has(port)) {
            await connectCall(
              "expose",
              { hostId, port },
              z.object({ url: z.string() }),
            );
            current.add(port);
          }
      });
    sharingQueues.set(hostId, next);
    await next;
  }
  bb.onDispose(async () => {
    for (const calls of opening.values())
      for (const call of calls) call.abort(new Error("Review plugin disposed"));
    for (const hostId of primaryHosts)
      await applyPorts(hostId, []).catch((e) =>
        bb.log.warn(`Review share cleanup: ${String(e)}`),
      );
  });
  const feedbacks = new Map<string, Promise<{ sent: boolean }>>();
  async function target(threadId: string) {
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.archivedAt || thread.deletedAt)
      throw new Error("This thread is archived or deleted");
    if (!thread.environmentId)
      throw new Error("This thread has no workspace to review");
    const env = await bb.sdk.environments.get({
      environmentId: thread.environmentId,
    });
    if (!env.path || env.hostLifecycle !== "active")
      throw new Error("The thread workspace is unavailable");
    return { thread, env };
  }
  async function publishPorts(hostId: string, signal?: AbortSignal) {
    const { sessions } = await host.call("status", null, { hostId });
    signal?.throwIfAborted();
    await applyPorts(
      hostId,
      sessions.filter((s) => s.url.startsWith("https:")).map((s) => s.port),
    );
  }
  host.experimental_onSignal("ports", ({ hostId, payload }) => {
    void applyPorts(hostId, payload.ports).catch((e) => bb.log.warn(String(e)));
  });
  host.experimental_onWorkerExit(({ hostId }) => {
    void applyPorts(hostId, []).catch((e) => bb.log.warn(String(e)));
    bb.realtime.publish("sessions-changed", { hostId });
  });
  async function stopThread(threadId: string) {
    const previous = stopping.get(threadId);
    if (previous) return previous;
    for (const call of opening.get(threadId) ?? [])
      call.abort(new Error("Review launch cancelled"));
    const task = (async () => {
      let stopped = 0;
      for (const hostId of activeHosts) {
        try {
          stopped += (await host.call("stop", { threadId }, { hostId }))
            .stopped;
          await publishPorts(hostId);
        } catch (e) {
          bb.log.warn(`Review cleanup: ${String(e)}`);
        }
      }
      bb.realtime.publish("sessions-changed", { threadId });
      return { stopped };
    })();
    stopping.set(threadId, task);
    try {
      return await task;
    } finally {
      stopping.delete(threadId);
    }
  }
  bb.rpc.register(rpcContract, {
    async open({ threadId, origin, remote }) {
      const controller = new AbortController();
      const calls = opening.get(threadId) ?? new Set<AbortController>();
      opening.set(threadId, calls);
      calls.add(controller);
      const check = () => controller.signal.throwIfAborted();
      try {
        await stopping.get(threadId);
        check();
        const { env } = await target(threadId);
        // Loopback URLs are usable only by a browser running on the workspace host.
        // Remote BB clients always use the authenticated Connect tunnel.
        const { primaryHostId } = await bb.sdk.system.config();
        const useTunnel = remote || env.hostId !== primaryHostId;
        const tunnel = useTunnel
          ? env.hostId === primaryHostId
            ? await primaryTunnel(env.hostId)
            : await bb.hosts.ensureSharedPortTunnel(env.hostId)
          : null;
        const key = createHash("sha256")
          .update(`${threadId}\n${env.id}\n${origin}\n${useTunnel}`)
          .digest("hex");
        const { binaryPath } = await settings.get();
        check();
        // Cleanup must know this host even while its first launch is pending.
        activeHosts.add(env.hostId);
        const session = await host.call(
          "ensure",
          { key, threadId, root: env.path!, origin, tunnel, binaryPath },
          { hostId: env.hostId, timeoutMs: 150000, signal: controller.signal },
        );
        check();
        try {
          const current = await target(threadId);
          check();
          if (
            current.env.id !== env.id ||
            current.env.hostId !== env.hostId ||
            current.env.path !== env.path
          )
            throw new Error(
              "The thread workspace changed while the review was starting",
            );
        } catch (e) {
          if (!controller.signal.aborted) await stopThread(threadId);
          throw e;
        }
        await publishPorts(env.hostId, controller.signal);
        check();
        return { ...session, environmentId: env.id, hostId: env.hostId };
      } finally {
        calls.delete(controller);
        if (!calls.size) opening.delete(threadId);
      }
    },
    stop: ({ threadId }) => stopThread(threadId),
    async feedback(input) {
      const { thread, env } = await target(input.threadId);
      if (env.id !== input.environmentId)
        throw new Error(
          "The thread workspace changed. Reopen the review before sending feedback.",
        );
      const key = `${thread.id}:${input.requestId}`;
      const previous = feedbacks.get(key);
      if (previous) return previous;
      const task = (async () => {
        const s = input.selection;
        const message = `Review feedback from px0 for ${JSON.stringify(s.path)}:${s.l1}-${s.l2}\n\n${input.instruction}\n\nSelected code (review context; verify against the current file):\n${JSON.stringify(s.text)}`;
        await bb.sdk.threads.send({
          threadId: thread.id,
          mode: "queue-if-active",
          input: [{ type: "text", text: message, mentions: [] }],
        });
        return { sent: true };
      })();
      feedbacks.set(key, task);
      if (feedbacks.size > 256)
        feedbacks.delete(feedbacks.keys().next().value!);
      try {
        return await task;
      } catch (e) {
        feedbacks.delete(key);
        throw e;
      }
    },
  });
  for (const event of ["thread.archived", "thread.deleted"] as const)
    bb.events.on(event, ({ thread }) => stopThread(thread.id).then(() => {}));
  bb.cli.register(
    defineCli({
      name: "px0-review",
      summary: "Inspect or stop px0 review sessions for BB worktrees",
      commands: {
        status: cliCommand({
          summary: "List active review sessions without authentication tokens",
          options: {},
          async run() {
            const sessions = [];
            for (const hostId of activeHosts) {
              const result = await host.call("status", null, { hostId });
              sessions.push(
                ...result.sessions.map(({ url, ...s }) => ({
                  ...s,
                  url: new URL(url).origin,
                  hostId,
                })),
              );
            }
            return {
              exitCode: 0,
              stdout: JSON.stringify({ sessions }, null, 2),
            };
          },
        }),
        stop: cliCommand({
          summary: "Stop review sessions for the current thread",
          options: {
            thread: {
              type: "string",
              description: "Thread ID (defaults to current thread)",
            },
          },
          async run({ options }, ctx) {
            const threadId = options.thread ?? ctx.threadId;
            if (!threadId) throw new Error("Pass --thread <thread-id>");
            return {
              exitCode: 0,
              stdout: JSON.stringify(await stopThread(threadId)),
            };
          },
        }),
      },
    }),
  );
}
