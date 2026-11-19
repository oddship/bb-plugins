import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  rpcContract,
  hostContract,
  type View,
  type SessionOwner,
} from "./contract";
import { mapLimit } from "./lib/collector";

export default function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const lifecycle = new AbortController();
  const titles = new Map<
    string,
    { at: number; title: string; projectId: string | null; status: string }
  >();
  const directories = new Map<string, { at: number; owners: SessionOwner[] }>();
  bb.onDispose(() => {
    lifecycle.abort();
    titles.clear();
    directories.clear();
  });
  const machines = async () =>
    (await bb.sdk.hosts.list()).map(({ id, name, status }) => ({
      id,
      name,
      status,
    }));
  async function sessionOwners(hostId: string): Promise<SessionOwner[]> {
    const cached = directories.get(hostId);
    if (cached && Date.now() - cached.at < 30000) return cached.owners;
    const threads: Awaited<ReturnType<typeof bb.sdk.threads.list>> = [];
    for (let offset = 0; offset < 1000; offset += 200) {
      const page = await bb.sdk.threads.list({
        hostId,
        includeHidden: true,
        limit: 200,
        offset,
        signal: lifecycle.signal,
      });
      threads.push(...page);
      if (page.length < 200) break;
    }
    const owners = (
      await mapLimit(
        threads.filter((t) => t.providerId === "codex"),
        8,
        async (thread) => {
          try {
            const events = await bb.sdk.threads.events.list({
              threadId: thread.id,
              types: ["thread/identity"],
              order: "desc",
              limit: "8",
              signal: lifecycle.signal,
            });
            return events.flatMap((event) =>
              event.type === "thread/identity" &&
              /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
                event.data.providerThreadId,
              )
                ? [
                    {
                      threadId: thread.id,
                      sessionId: event.data.providerThreadId,
                    },
                  ]
                : [],
            );
          } catch {
            return [];
          }
        },
      )
    ).flat();
    directories.set(hostId, { at: Date.now(), owners });
    return owners;
  }
  async function snapshot({ hostId }: { hostId: string }): Promise<View> {
    const machine = (await machines()).find((m) => m.id === hostId);
    if (!machine) throw new Error("Choose an enrolled BB machine.");
    if (machine.status !== "connected")
      throw new Error(
        `${machine.name} is ${machine.status}. Connect it to read resource usage.`,
      );
    const sample = await host.call(
      "sample",
      { sessionOwners: await sessionOwners(hostId) },
      { hostId, signal: lifecycle.signal },
    );
    if (titles.size > 2000) titles.clear();
    const threads = await mapLimit(sample.threads, 8, async (row) => {
      let title = titles.get(row.id);
      if (!title || Date.now() - title.at > 30000) {
        try {
          const thread = await bb.sdk.threads.get({ threadId: row.id });
          title = {
            at: Date.now(),
            title: thread.title ?? thread.titleFallback ?? row.id,
            projectId: thread.projectId,
            status: thread.status,
          };
          titles.set(row.id, title);
        } catch {
          title = {
            at: Date.now(),
            title: row.id,
            projectId: null,
            status: "unknown",
          };
        }
      }
      return {
        ...row,
        title: title.title,
        projectId: title.projectId,
        status: title.status,
      };
    });
    return { ...sample, threads, hostId, hostName: machine.name };
  }
  bb.rpc.register(rpcContract, { machines, snapshot });
  bb.cli.register({
    name: "top",
    summary: "CPU and resident memory by BB thread",
    commands: [
      {
        name: "status",
        summary: "Read a machine resource snapshot",
        usage: "bb top status [--machine <id-or-name>] [--json]",
      },
    ],
    async run(argv) {
      const usage =
        "Usage: bb top [status] [--machine <id-or-name>] [--json]\nCPU is percent of one core. RSS is summed resident memory. First reading warms up the CPU counters.";
      if (argv.includes("--help") || argv.includes("help"))
        return { exitCode: 0, stdout: usage };
      let selected: string | undefined;
      let json = false;
      for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--json") json = true;
        else if (
          argv[i] === "--machine" &&
          argv[i + 1] &&
          !argv[i + 1].startsWith("--")
        )
          selected = argv[++i];
        else if (i !== 0 || argv[i] !== "status")
          return { exitCode: 1, stderr: usage };
      }
      try {
        const list = await machines();
        const matches = selected
          ? list.filter((m) => m.id === selected || m.name === selected)
          : list.filter((m) => m.status === "connected");
        if (matches.length !== 1)
          return {
            exitCode: 1,
            stderr:
              "Select a machine with --machine <id-or-name>.\n" +
              list.map((m) => `${m.id}  ${m.name}  ${m.status}`).join("\n"),
          };
        const view = await snapshot({ hostId: matches[0].id });
        const lines = [
          `BB Top | ${view.hostName} | ${new Date(view.at).toISOString()}`,
          view.intervalMs
            ? "CPU% (one core)   RSS MiB  PROCS  THREAD"
            : "CPU warming up; sample again in 2 seconds.\nCPU% (one core)   RSS MiB  PROCS  THREAD",
          ...view.threads.map(
            (t) =>
              `${(view.intervalMs ? t.cpu.toFixed(1) : "-").padStart(15)}  ${(t.rss / 1048576).toFixed(1).padStart(8)}  ${String(t.count).padStart(5)}  ${t.title} (${t.id})`,
          ),
          `${view.unattributed} processes outside attributed threads. RSS may count shared pages more than once.`,
        ];
        return {
          exitCode: 0,
          stdout: json ? JSON.stringify(view) : lines.join("\n"),
        };
      } catch (error) {
        return {
          exitCode: 1,
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}
