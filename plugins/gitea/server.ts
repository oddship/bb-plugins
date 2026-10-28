import {
  cliCommand,
  defineCli,
  PluginCliError,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { hostContract, rpcContract, slug } from "./contract.js";
export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    hostId: {
      type: "string",
      label: "Machine ID running tea (empty: the only connected machine)",
      default: "",
    },
    login: { type: "string", label: "Default tea login name", default: "" },
  });
  const host = bb.hosts.experimental_client({ contract: hostContract });
  async function machine(explicit?: string) {
    const config = await settings.get();
    if (explicit || config.hostId) return explicit || config.hostId;
    const machines = (await bb.sdk.hosts.list()).filter(
      (m) => m.status === "connected",
    );
    if (machines.length !== 1)
      throw new Error(
        "Set the Gitea plugin’s hostId setting, or pass --machine, to select the machine running tea.",
      );
    return machines[0]!.id;
  }
  async function connection() {
    const hostId = await machine();
    const logins = await host.call("logins", {}, { hostId });
    const config = await settings.get();
    return {
      hostId,
      login: config.login || (logins.length === 1 ? logins[0]!.name : ""),
      logins,
    };
  }
  bb.rpc.register(rpcContract, {
    connection,
    repos: async (i) =>
      host.call("repos", i, { hostId: await machine(i.hostId) }),
    items: async (i) =>
      host.call("items", i, { hostId: await machine(i.hostId) }),
    detail: async (i) =>
      host.call("detail", i, { hostId: await machine(i.hostId) }),
  });
  const common = {
    login: {
      type: "string" as const,
      description: "tea login name (defaults to plugin setting or sole login)",
    },
    machine: { type: "string" as const, description: "Machine ID running tea" },
    json: { type: "boolean" as const, description: "Emit JSON" },
  };
  async function context(
    options: { login?: string; machine?: string },
    signal?: AbortSignal,
  ) {
    const hostId = await machine(options.machine);
    const config = await settings.get();
    let login = options.login || config.login;
    if (!login) {
      const logins = await host.call("logins", {}, { hostId, signal });
      if (logins.length === 1) login = logins[0]!.name;
    }
    if (!login)
      throw new PluginCliError("Choose a tea login with --login.", {
        code: "login_required",
      });
    return { hostId, login };
  }
  const page = {
    type: "integer" as const,
    description: "Page number (30 rows per page)",
    default: 1,
    min: 1,
    max: 10000,
  };
  const commands = {
    logins: cliCommand({
      summary: "List tea logins on the selected machine",
      options: { machine: common.machine, json: common.json },
      async run(i, c) {
        const rows = await host.call(
          "logins",
          {},
          { hostId: await machine(i.options.machine), signal: c.signal },
        );
        return {
          exitCode: 0,
          stdout: i.options.json
            ? JSON.stringify(rows)
            : rows.map((r) => `${r.name}\t${r.user}\t${r.url}`).join("\n") ||
              "No tea logins found.",
        };
      },
    }),
    repos: cliCommand({
      summary: "List accessible Gitea repositories",
      options: { ...common, page },
      async run(i, c) {
        const ctx = await context(i.options, c.signal);
        const input = hostContract.repos.input.parse({
          ...ctx,
          page: i.options.page,
        });
        const rows = await host.call("repos", input, {
          hostId: ctx.hostId,
          signal: c.signal,
        });
        return {
          exitCode: 0,
          stdout: i.options.json
            ? JSON.stringify(rows)
            : rows.map((r) => r.name).join("\n"),
        };
      },
    }),
    ...Object.fromEntries(
      (["issues", "prs"] as const).map((command) => [
        command,
        cliCommand({
          summary: `List Gitea ${command === "prs" ? "pull requests" : "issues"}`,
          positionals: [
            { name: "repo", description: "owner/repo", required: true },
          ],
          options: {
            ...common,
            page,
            state: {
              type: "enum" as const,
              values: ["open", "closed", "all"],
              default: "open",
              description: "Filter item state",
            },
          },
          async run(i, c) {
            const ctx = await context(i.options, c.signal);
            const input = hostContract.items.input.parse({
              ...ctx,
              repo: slug.parse(i.positionals.repo),
              kind: command === "prs" ? "pulls" : "issues",
              state: i.options.state,
              page: i.options.page,
            });
            const rows = await host.call("items", input, {
              hostId: ctx.hostId,
              signal: c.signal,
            });
            return {
              exitCode: 0,
              stdout: i.options.json
                ? JSON.stringify(rows)
                : rows
                    .map((r) => `#${r.number}\t[${r.state}] ${r.title}`)
                    .join("\n") || "No results.",
            };
          },
        }),
      ]),
    ),
    view: cliCommand({
      summary: "Read an issue or pull request and the first 30 comments",
      positionals: [
        { name: "repo", description: "owner/repo", required: true },
        { name: "number", description: "Issue or PR number", required: true },
      ],
      options: {
        ...common,
        kind: {
          type: "enum",
          values: ["issues", "pulls"],
          default: "issues",
          description: "Item kind",
        },
      },
      async run(i, c) {
        const ctx = await context(i.options, c.signal);
        const input = hostContract.detail.input.parse({
          ...ctx,
          repo: i.positionals.repo,
          number: Number(i.positionals.number),
          kind: i.options.kind,
        });
        const r = await host.call("detail", input, {
          hostId: ctx.hostId,
          signal: c.signal,
        });
        return {
          exitCode: 0,
          stdout: i.options.json
            ? JSON.stringify(r)
            : `#${r.item.number} ${r.item.title}\n${r.item.url}\n\n${r.item.body}\n\n${r.comments.map((c) => `${c.author}: ${c.body}`).join("\n\n")}`,
        };
      },
    }),
  };
  bb.cli.register(
    defineCli({
      name: "oddship-gitea",
      summary:
        "Browse Gitea repositories, issues and pull requests through tea",
      commands,
    }),
  );
}
