import { test } from "node:test";
import assert from "node:assert/strict";
import { commandArgs, runBcat } from "./bcat.js";
import { request } from "./contract.js";
test("identifiers reject flags, traversal and malformed IDs", () => {
  for (const id of ["--help", "../DEV-1", "DEV-0", "DEV-1/../../me"])
    assert.throws(() => request.parse({ action: "task", id }));
});
test("arguments preserve text and isolate positional values", () => {
  assert.deepEqual(
    commandArgs({
      action: "comment",
      id: "DEV-1",
      content: "--help $(touch /tmp/no)",
    }),
    ["--yes", "comment", "--", "DEV-1", "--help $(touch /tmp/no)"],
  );
});
test("update preserves zero priority and empty description", () => {
  assert.deepEqual(
    commandArgs({
      action: "update",
      id: "DEV-1",
      description: "",
      priority: 0,
    }),
    [
      "--yes",
      "task",
      "update",
      "--description",
      "",
      "--priority",
      "0",
      "--",
      "DEV-1",
    ],
  );
  assert.throws(() => request.parse({ action: "update", id: "DEV-1" }));
});
test("read commands never approve writes", () => {
  for (const r of [
    { action: "whoami" },
    { action: "projects" },
    { action: "mytasks" },
    { action: "tasks", project: "DEV" },
    { action: "task", id: "DEV-1" },
  ])
    assert.ok(!commandArgs(request.parse(r)).includes("--yes"));
});
test("subprocess errors never expose stderr or tokens", async () => {
  await assert.rejects(
    runBcat("/bin/sh", { action: "whoami" }, "https://tasks.example.com"),
    (e) => e instanceof Error && !e.message.includes("illegal option"),
  );
  await assert.rejects(
    runBcat("/no-such-bcat", { action: "whoami" }, "https://tasks.example.com"),
    /CLI not found/,
  );
});
