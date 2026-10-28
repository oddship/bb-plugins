import { cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import {
  hostContract,
  rpcContract,
  request,
  serviceUrl,
  type Request,
} from "./contract.js";
import { withoutUndefined } from "./model.js";
export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    baseUrl: { type: "string", label: "Bureaucat service URL", default: "" },
    hostId: {
      type: "string",
      label: "Machine running Bureaucat (empty: sole connected machine)",
      default: "",
    },
    binaryPath: {
      type: "string",
      label: "Bureaucat executable name or absolute path",
      default: "bcat",
    },
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
        "Select the machine running bcat in the Bureaucat plugin hostId setting or use --machine.",
      );
    return machines[0]!.id;
  }
  async function execute(r: Request, hostId?: string, signal?: AbortSignal) {
    const config = await settings.get();
    if (!serviceUrl.safeParse(config.baseUrl).success)
      throw new Error("Set a valid Bureaucat service URL in plugin settings.");
    return host.call(
      "execute",
      {
        binary: config.binaryPath,
        baseUrl: serviceUrl.parse(config.baseUrl),
        request: withoutUndefined(request.parse(r)),
      },
      { hostId: await machine(hostId), signal, timeoutMs: 55000 },
    );
  }
  bb.rpc.register(rpcContract, {
    execute: (i) => execute(i.request, i.hostId),
    connection: async () => {
      const hostId = await machine();
      const user = await execute({ action: "whoami" }, hostId);
      if (!("username" in user))
        throw new Error("Unexpected identity response");
      return {
        hostId,
        url: serviceUrl.parse((await settings.get()).baseUrl),
        username: user.username,
      };
    },
  });
  const common = {
    machine: { type: "string" as const, description: "BB machine ID" },
    json: { type: "boolean" as const, description: "Emit JSON" },
  };
  const page = {
    type: "integer" as const,
    description: "Page (30 items)",
    default: 1,
    min: 1,
    max: 10000,
  };
  const q = {
    type: "string" as const,
    description: "Search text",
    default: "",
  };
  const fields = {
    title: { type: "string" as const, description: "Task title" },
    description: { type: "string" as const, description: "Task description" },
    priority: {
      type: "integer" as const,
      description: "Priority 0–4",
      min: 0,
      max: 4,
    },
    "state-id": {
      type: "string" as const,
      description: "Workflow state UUID",
    },
  };
  const listing = {
    "per-page": {
      type: "integer" as const,
      description: "Rows per page",
      default: 30,
      min: 1,
      max: 100,
    },
    sort: {
      type: "enum" as const,
      description: "Sort all matching tasks",
      values: [
        "default",
        "title",
        "priority",
        "state",
        "number",
        "comments",
        "created",
        "updated",
      ],
      default: "default",
    },
    direction: {
      type: "enum" as const,
      description: "Sort direction",
      values: ["asc", "desc"],
      default: "asc",
    },
    priority: fields.priority,
    label: { type: "string" as const, description: "Label name contains" },
    state: {
      type: "enum" as const,
      description: "State type",
      values: ["", "backlog", "unstarted", "started", "completed", "cancelled"],
      default: "",
    },
  };
  const extraFilters = {
    "state-id": fields["state-id"],
    "assigned-to": {
      type: "string" as const,
      description: "Assignee username or user UUID",
    },
    "created-by": {
      type: "string" as const,
      description: "Creator username or user UUID",
    },
    "from-date": {
      type: "string" as const,
      description: "Created on/after YYYY-MM-DD",
    },
    "to-date": {
      type: "string" as const,
      description: "Created on/before YYYY-MM-DD",
    },
  };
  const listInput = (o: Record<string, unknown>) => ({
    ...o,
    perPage: o["per-page"],
    stateId: o["state-id"],
    assignedTo: o["assigned-to"],
    createdBy: o["created-by"],
    fromDate: o["from-date"],
    toDate: o["to-date"],
  });
  const reply = (value: unknown, json?: boolean) => ({
    exitCode: 0,
    stdout: json ? JSON.stringify(value) : JSON.stringify(value, null, 2),
  });
  bb.cli.register(
    defineCli({
      name: "bureaucat",
      summary: "Browse and manage Bureaucat tasks through bcat",
      commands: {
        whoami: cliCommand({
          summary: "Check CLI authentication",
          options: common,
          async run(i, c) {
            return reply(
              await execute({ action: "whoami" }, i.options.machine, c.signal),
              i.options.json,
            );
          },
        }),
        projects: cliCommand({
          summary: "List projects",
          options: { ...common, page, q },
          async run(i, c) {
            return reply(
              await execute(
                { action: "projects", page: i.options.page, q: i.options.q },
                i.options.machine,
                c.signal,
              ),
              i.options.json,
            );
          },
        }),
        mytasks: cliCommand({
          summary: "List tasks assigned to you",
          options: { ...common, page, q, ...listing },
          async run(i, c) {
            return reply(
              await execute(
                request.parse({ action: "mytasks", ...listInput(i.options) }),
                i.options.machine,
                c.signal,
              ),
              i.options.json,
            );
          },
        }),
        tasks: cliCommand({
          summary: "List project tasks",
          positionals: [
            { name: "project", description: "Project key", required: true },
          ],
          options: { ...common, page, q, ...listing, ...extraFilters },
          async run(i, c) {
            return reply(
              await execute(
                request.parse({
                  action: "tasks",
                  project: i.positionals.project,
                  ...listInput(i.options),
                }),
                i.options.machine,
                c.signal,
              ),
              i.options.json,
            );
          },
        }),
        view: cliCommand({
          summary: "Read a task",
          positionals: [
            { name: "id", description: "Task ID e.g. DEV-123", required: true },
          ],
          options: common,
          async run(i, c) {
            return reply(
              await execute(
                request.parse({ action: "task", id: i.positionals.id }),
                i.options.machine,
                c.signal,
              ),
              i.options.json,
            );
          },
        }),
        create: cliCommand({
          summary: "Create a task",
          positionals: [
            { name: "project", description: "Project key", required: true },
          ],
          options: {
            ...common,
            ...fields,
            assignees: {
              type: "string",
              description: "Comma-separated assignee user UUIDs",
            },
            labels: {
              type: "string",
              description: "Comma-separated label UUIDs",
            },
            yes: { type: "boolean", description: "Apply this write" },
          },
          async run(i, c) {
            if (!i.options.yes)
              throw new Error("Pass --yes to create the task.");
            return reply(
              await execute(
                request.parse({
                  action: "create",
                  project: i.positionals.project,
                  ...i.options,
                  stateId: i.options["state-id"],
                  assignees: i.options.assignees
                    ?.split(",")
                    .map((v) => v.trim())
                    .filter(Boolean),
                  labels: i.options.labels
                    ?.split(",")
                    .map((v) => v.trim())
                    .filter(Boolean),
                }),
                i.options.machine,
                c.signal,
              ),
              i.options.json,
            );
          },
        }),
        update: cliCommand({
          summary: "Update task fields",
          positionals: [{ name: "id", description: "Task ID", required: true }],
          options: {
            ...common,
            ...fields,
            yes: { type: "boolean", description: "Apply this write" },
          },
          async run(i, c) {
            if (!i.options.yes)
              throw new Error("Pass --yes to update the task.");
            return reply(
              await execute(
                request.parse({
                  action: "update",
                  id: i.positionals.id,
                  ...i.options,
                  stateId: i.options["state-id"],
                }),
                i.options.machine,
                c.signal,
              ),
              i.options.json,
            );
          },
        }),
        comment: cliCommand({
          summary: "Post a comment",
          positionals: [
            { name: "id", description: "Task ID", required: true },
            { name: "content", description: "Comment text", required: true },
          ],
          options: {
            ...common,
            yes: { type: "boolean", description: "Post this comment" },
          },
          async run(i, c) {
            if (!i.options.yes)
              throw new Error("Pass --yes to post the comment.");
            return reply(
              await execute(
                request.parse({
                  action: "comment",
                  id: i.positionals.id,
                  content: i.positionals.content,
                }),
                i.options.machine,
                c.signal,
              ),
              i.options.json,
            );
          },
        }),
      },
    }),
  );
}
