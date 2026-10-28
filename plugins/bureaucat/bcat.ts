import { execFile } from "node:child_process";
import {
  request,
  result,
  tasksSchema,
  serviceUrl,
  type Request,
} from "./contract.js";
import { filterAndSort } from "./model.js";
export function commandArgs(input: Request): string[] {
  const r = request.parse(input);
  const paging = (p: number) => [
    "--page",
    String(p),
    "--per-page",
    String("perPage" in r ? (r.perPage ?? 30) : 30),
  ];
  switch (r.action) {
    case "whoami":
      return ["whoami"];
    case "projects":
      return ["projects", ...paging(r.page), "--search", r.q];
    case "mytasks":
      return ["mytasks", ...paging(r.page)];
    case "tasks":
      return [
        "tasks",
        ...paging(r.page),
        "--q",
        r.q,
        ...(r.state ? ["--state-type", r.state] : []),
        ...(
          [
            "stateId",
            "assignedTo",
            "createdBy",
            "priority",
            "fromDate",
            "toDate",
          ] as const
        ).flatMap((k) =>
          r[k] !== undefined
            ? [
                "--" +
                  {
                    stateId: "state-id",
                    assignedTo: "assigned-to",
                    createdBy: "created-by",
                    priority: "priority",
                    fromDate: "from-date",
                    toDate: "to-date",
                  }[k],
                String(r[k]),
              ]
            : [],
        ),
        "--",
        r.project,
      ];
    case "task":
      return ["task", "--", r.id];
    case "comment":
      return ["--yes", "comment", "--", r.id, r.content];
    case "create":
      return [
        "--yes",
        "task",
        "create",
        "--title",
        r.title,
        ...(r.description !== undefined
          ? ["--description", r.description]
          : []),
        ...(r.priority !== undefined ? ["--priority", String(r.priority)] : []),
        ...(r.stateId ? ["--state-id", r.stateId] : []),
        ...(r.assignees ?? []).flatMap((v) => ["--assignee", v]),
        ...(r.labels ?? []).flatMap((v) => ["--label", v]),
        "--",
        r.project,
      ];
    case "update":
      return [
        "--yes",
        "task",
        "update",
        ...(["title", "description", "stateId", "priority"] as const).flatMap(
          (k) =>
            r[k] !== undefined
              ? ["--" + (k === "stateId" ? "state-id" : k), String(r[k])]
              : [],
        ),
        "--",
        r.id,
      ];
  }
}
function runCommand(
  binary: string,
  input: Request,
  baseUrl: string,
  signal?: AbortSignal,
) {
  const args = commandArgs(input);
  return new Promise<ReturnType<typeof result.parse>>((resolve, reject) => {
    const child = execFile(
      binary,
      args,
      {
        signal,
        timeout: 25000,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          BUREAUCAT_URL: baseUrl,
          NO_COLOR: "1",
        },
      },
      (error, stdout) => {
        if (error)
          return reject(
            new Error(
              (error as NodeJS.ErrnoException).code === "ENOENT"
                ? "Bureaucat CLI not found. Install bcat (upstream binary: bureaucat) on the selected machine and set binaryPath."
                : "Bureaucat request failed or timed out. Check CLI login for the configured Bureaucat service, permissions and connectivity. Writes are not retried; refresh before trying again.",
            ),
          );
        try {
          resolve(result.parse(JSON.parse(stdout)));
        } catch {
          reject(
            new Error(
              "Bureaucat returned unexpected JSON. Check CLI version and authentication.",
            ),
          );
        }
      },
    );
    child.stdin?.end();
  });
}

export const MAX_SCAN = 5000;
type ListRequest = Extract<Request, { action: "tasks" | "mytasks" }>;
export async function browseTasks(
  input: ListRequest,
  read: (r: ListRequest) => Promise<unknown>,
) {
  if (
    input.action === "mytasks" &&
    ["created", "updated"].includes(input.sort ?? "")
  )
    throw new Error(
      "Assigned task lists do not include timestamps. Select a project to sort by created or updated date.",
    );
  if (input.action === "mytasks" && input.label)
    throw new Error(
      "Assigned task lists do not include labels. Select a project to filter by label.",
    );
  const aggregate = !!(
    (input.sort && input.sort !== "default") ||
    input.q ||
    input.state ||
    input.priority !== undefined ||
    input.label ||
    (input.action === "tasks" &&
      (input.stateId ||
        input.assignedTo ||
        input.createdBy ||
        input.fromDate ||
        input.toDate))
  );
  if (
    input.action === "tasks" &&
    input.fromDate &&
    input.toDate &&
    input.fromDate > input.toDate
  )
    throw new Error("Created from date must precede the to date.");
  if (!aggregate) return tasksSchema.parse(await read(input));
  // Fetch without legacy filters: upstream currently ignores these query params.
  // Filtering ourselves also avoids changing results between old/new deployments.
  const raw = (page: number): ListRequest =>
    input.action === "tasks"
      ? {
          action: "tasks",
          project: input.project,
          page,
          perPage: 100,
          q: "",
          state: "",
        }
      : { action: "mytasks", page, perPage: 100 };
  const first = tasksSchema.parse(await read(raw(1)));
  if (first.total > MAX_SCAN || first.total_pages > MAX_SCAN / 100)
    throw new Error(
      `Sorting and filtering support up to ${MAX_SCAN} source tasks. This view exceeds that limit; use the default paginated list or open Bureaucat.`,
    );
  const tasks = [...first.tasks];
  for (let page = 2; page <= first.total_pages; page += 4) {
    const pages = await Promise.all(
      Array.from(
        { length: Math.min(4, first.total_pages - page + 1) },
        (_, i) => read(raw(page + i)).then((v) => tasksSchema.parse(v)),
      ),
    );
    for (const next of pages) {
      if (next.total !== first.total)
        throw new Error("Tasks changed while loading. Refresh to try again.");
      tasks.push(...next.tasks);
    }
  }
  if (
    tasks.length !== first.total ||
    new Set(tasks.map((t) => t.id)).size !== tasks.length
  )
    throw new Error(
      "Task pages changed or were incomplete. Refresh to try again.",
    );
  const rows = filterAndSort(tasks, input);
  const perPage = input.perPage ?? 30;
  const offset = (input.page - 1) * perPage;
  return tasksSchema.parse({
    tasks: rows.slice(offset, offset + perPage),
    page: input.page,
    total: rows.length,
    total_pages: Math.ceil(rows.length / perPage),
  });
}
export async function runBcat(
  binary: string,
  input: Request,
  baseUrl: string,
  signal?: AbortSignal,
) {
  const r = request.parse(input);
  const url = serviceUrl.parse(baseUrl);
  const controller = new AbortController();
  const combined = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(45000),
    ...(signal ? [signal] : []),
  ]);
  try {
    return r.action === "tasks" || r.action === "mytasks"
      ? await browseTasks(r, (v) => runCommand(binary, v, url, combined))
      : await runCommand(binary, r, url, combined);
  } finally {
    controller.abort();
  }
}
