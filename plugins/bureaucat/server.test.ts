import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createFakePluginHost,
  experimental_scanPublicSdkOnly,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";
const user = { id: "u1", username: "test" };
function fixture(hosts = [{ id: "machine1", status: "connected" }]) {
  return createFakePluginHost({
    pluginId: "bureaucat",
    settings: { baseUrl: "https://tasks.example.com" },
    sdk: { hosts: { list: async () => hosts as never } },
    experimental_callHostRpc: async () => user,
  });
}
test("RPC chooses sole connected host and respects configured binary", async () => {
  const { bb, harness } = fixture();
  await plugin(bb);
  await harness.behavior.setSettings({ binaryPath: "/usr/bin/bcat" });
  const r = await harness.behavior.callRpc("connection", null);
  assert.equal((r as { hostId: string }).hostId, "machine1");
  const calls = harness.experimental_hostRpcCalls;
  assert.ok(JSON.stringify(calls).includes("/usr/bin/bcat"));
  await harness.lifecycle.dispose();
});
test("ambiguous host requires explicit selection", async () => {
  const { bb, harness } = fixture([
    { id: "m1", status: "connected" },
    { id: "m2", status: "connected" },
  ]);
  await plugin(bb);
  await assert.rejects(
    harness.behavior.callRpc("connection", null),
    /Select the machine/,
  );
  await harness.lifecycle.dispose();
});
test("CLI refuses writes without --yes before invoking host", async () => {
  const { bb, harness } = fixture();
  await plugin(bb);
  for (const argv of [
    ["comment", "DEV-1", "hello"],
    ["create", "DEV", "--title", "hello"],
    ["update", "DEV-1", "--priority", "0"],
  ]) {
    const result = await harness.behavior.runCli(argv);
    assert.notEqual(result.exitCode, 0);
  }
  assert.equal(harness.experimental_hostRpcCalls.length, 0);
  await harness.lifecycle.dispose();
});
test("invalid update is rejected before host call", async () => {
  const { bb, harness } = fixture();
  await plugin(bb);
  const r = await harness.behavior.runCli(["update", "DEV-1", "--yes"]);
  assert.notEqual(r.exitCode, 0);
  assert.equal(harness.experimental_hostRpcCalls.length, 0);
  await harness.lifecycle.dispose();
});
test("uses public SDK only", async () => {
  const r = await experimental_scanPublicSdkOnly(
    new URL(".", import.meta.url).pathname,
    {
      allow: [
        /^dompurify$/,
        /^jsdom$/,
        /^@testing-library\/react$/,
        /^react(?:-dom)?$/,
        /^@\/components\/ui\//,
        /^@radix-ui\/react-slot$/,
        /^class-variance-authority$/,
        /^clsx$/,
        /^tailwind-merge$/,
      ],
    },
  );
  assert.deepEqual(r.violations, []);
  assert.deepEqual(r.privateDependencies, []);
});

test("CLI maps extended creation and filtering flags into typed host requests", async () => {
  const { bb, harness } = fixture();
  await plugin(bb);
  const uuid = "11111111-1111-4111-8111-111111111111";
  try {
    const created = await harness.behavior.runCli([
      "create",
      "DEV",
      "--title",
      "Task",
      "--state-id",
      uuid,
      "--assignees",
      uuid,
      "--labels",
      uuid,
      "--yes",
    ]);
    assert.equal(created.exitCode, 0);
    const listed = await harness.behavior.runCli([
      "tasks",
      "DEV",
      "--assigned-to",
      "alice",
      "--priority",
      "0",
      "--sort",
      "title",
      "--per-page",
      "15",
      "--from-date",
      "2026-10-01",
    ]);
    assert.equal(listed.exitCode, 0);
    const calls = JSON.stringify(harness.experimental_hostRpcCalls);
    assert.ok(calls.includes('"assignedTo":"alice"'));
    assert.ok(calls.includes('"priority":0'));
    assert.ok(calls.includes('"assignees":["' + uuid + '"]'));
    assert.ok(calls.includes('"perPage":15'));
  } finally {
    await harness.lifecycle.dispose();
  }
});
