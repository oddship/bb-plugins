import { test } from "node:test";
import assert from "node:assert/strict";
import { browseTasks, MAX_SCAN, commandArgs } from "./bcat.js";
import { request, serviceUrl, type Task, type Request } from "./contract.js";
import { filterAndSort, taskUrl } from "./model.js";
const uuid = "11111111-1111-4111-8111-111111111111";
function task(n: number): Task {
  return {
    id: `id${n}`,
    task_id: `DEV-${n}`,
    project_key: "DEV",
    task_number: n,
    title: `Title ${String(1000 - n).padStart(4, "0")}`,
    priority: n % 5,
    state_name: "Todo",
    state_type: "unstarted",
    created_at: "2026-10-28T12:00:00Z",
    updated_at: "2026-10-28T13:00:00Z",
    created_by: uuid,
    creator_username: "alice",
    assignees: [{ user_id: uuid, username: "alice" }],
    labels: [{ id: uuid, name: "Bug" }],
    comment_count: n,
  };
}
const all = Array.from({ length: 205 }, (_, n) => task(n + 1));
function reader(rows = all) {
  const calls: Request[] = [];
  return {
    calls,
    read: async (r: Extract<Request, { action: "tasks" | "mytasks" }>) => {
      calls.push(r);
      const size = r.perPage ?? 30;
      return {
        tasks: rows.slice((r.page - 1) * size, r.page * size),
        page: r.page,
        total: rows.length,
        total_pages: Math.ceil(rows.length / size),
      };
    },
  };
}
test("global sorting happens before pagination and reads every page", async () => {
  const r = reader();
  const result = await browseTasks(
    request.parse({
      action: "tasks",
      project: "DEV",
      page: 2,
      perPage: 15,
      sort: "number",
      direction: "desc",
    }) as Extract<Request, { action: "tasks" }>,
    r.read,
  );
  assert.equal(result.total, 205);
  assert.equal(result.tasks[0]!.task_number, 190);
  assert.equal(result.tasks.at(-1)!.task_number, 176);
  assert.equal(r.calls.length, 3);
});
test("filtering is enforced even when upstream ignores legacy parameters", async () => {
  const r = reader();
  const out = await browseTasks(
    request.parse({
      action: "tasks",
      project: "DEV",
      priority: 0,
      q: "DEV-20",
      assignedTo: "@alice",
      label: "bug",
      fromDate: "2026-10-28",
      toDate: "2026-10-28",
    }) as Extract<Request, { action: "tasks" }>,
    r.read,
  );
  assert.deepEqual(
    out.tasks.map((t) => t.task_number),
    [20, 200, 205],
  );
  assert.equal(out.total, 3);
  assert.ok(r.calls.every((r) => !("priority" in r)));
});
test("assigned tasks search and state filter cover all pages", async () => {
  const r = reader();
  const out = await browseTasks(
    request.parse({
      action: "mytasks",
      q: "DEV-205",
      state: "unstarted",
    }) as Extract<Request, { action: "mytasks" }>,
    r.read,
  );
  assert.deepEqual(
    out.tasks.map((t) => t.task_number),
    [205],
  );
});
test("default list stays server-paginated", async () => {
  const r = reader();
  const out = await browseTasks({ action: "mytasks", page: 2 }, r.read);
  assert.equal(r.calls.length, 1);
  assert.equal(out.tasks[0]!.task_number, 31);
});
test("oversized source is refused, never partially sorted", async () => {
  await assert.rejects(
    browseTasks({ action: "mytasks", page: 1, sort: "title" }, async () => ({
      tasks: [],
      page: 1,
      total: MAX_SCAN + 1,
      total_pages: 51,
    })),
    /exceeds that limit/,
  );
});
test("incomplete or shifting pages cannot silently drop tasks", async () => {
  await assert.rejects(
    browseTasks({ action: "mytasks", page: 1, sort: "title" }, async (r) => ({
      tasks: [task(1)],
      page: r.page,
      total: 2,
      total_pages: 2,
    })),
    /incomplete/,
  );
});
test("date ranges validate before reading and assigned date sorting fails clearly", async () => {
  await assert.rejects(
    browseTasks(
      request.parse({
        action: "tasks",
        project: "DEV",
        fromDate: "2026-10-29",
        toDate: "2026-10-28",
      }) as Extract<Request, { action: "tasks" }>,
      async () => {
        throw Error("should not read");
      },
    ),
    /must precede/,
  );
  assert.throws(() =>
    request.parse({ action: "tasks", project: "DEV", fromDate: "2026-02-30" }),
  );
  await assert.rejects(
    browseTasks(
      { action: "mytasks", page: 1, sort: "created" },
      async () => ({}),
    ),
    /do not include timestamps/,
  );
});
test("missing timestamps sort last in both directions and ties stay stable", () => {
  const rows = [
    { ...task(1), created_at: undefined },
    { ...task(2), created_at: "2026-10-28" },
    { ...task(3), created_at: "2026-10-27" },
  ];
  assert.deepEqual(
    filterAndSort(rows, { sort: "created", direction: "desc" }).map(
      (t) => t.task_number,
    ),
    [2, 3, 1],
  );
  assert.deepEqual(
    filterAndSort(rows, { sort: "created", direction: "asc" }).map(
      (t) => t.task_number,
    ),
    [3, 2, 1],
  );
});
test("creation forwards state and repeatable assignee/label flags safely", () => {
  const args = commandArgs({
    action: "create",
    project: "DEV",
    title: "Task",
    stateId: uuid,
    assignees: [uuid],
    labels: [uuid],
  });
  assert.deepEqual(args.slice(5), [
    "--state-id",
    uuid,
    "--assignee",
    uuid,
    "--label",
    uuid,
    "--",
    "DEV",
  ]);
});
test("service URLs reject unsafe schemes and embedded credentials", () => {
  for (const url of [
    "file:///tmp/api",
    "https://user:secret@example.com",
    "https://example.com/?token=x",
  ])
    assert.throws(() => serviceUrl.parse(url));
  assert.equal(
    serviceUrl.parse("https://tasks.example.com/api/v1/"),
    "https://tasks.example.com",
  );
  assert.equal(
    taskUrl(task(1), "https://tasks.example.com"),
    "https://tasks.example.com/projects/DEV/tasks/1",
  );
});

test("assigned label filtering refuses unavailable metadata instead of returning false negatives", async () => {
  await assert.rejects(
    browseTasks({ action: "mytasks", page: 1, label: "bug" }, async () => {
      throw Error("should not read");
    }),
    /do not include labels/,
  );
});
