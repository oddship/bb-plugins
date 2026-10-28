import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createFakePluginHost,
  experimental_scanPublicSdkOnly,
} from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import plugin from "./server.js";
import hostEntry from "./host.js";
function setup(
  settings: Record<string, string> = { hostId: "machine-1", login: "work" },
) {
  const calls: { method: string; input: unknown; hostId: string }[] = [];
  const fake = createFakePluginHost({
    pluginId: "oddship-gitea",
    experimental_hostEntry: true,
    settings,
    experimental_callHostRpc: async (request) => {
      calls.push({
        method: request.method,
        input: request.input,
        hostId: request.hostId,
      });
      if (request.method === "logins")
        return [{ name: "work", url: "https://git.example/", user: "alice" }];
      if (request.method === "repos")
        return [
          { name: "a/b", url: "https://git.example/a/b", description: "" },
        ];
      if (request.method === "items") return [];
      throw new Error("Unexpected method");
    },
  });
  return { ...fake, calls };
}
test("server RPC routes tea to selected host and passes validated values", async () => {
  const { bb, harness, calls } = setup();
  try {
    await plugin(bb);
    assert.deepEqual(await harness.behavior.callRpc("connection", null), {
      hostId: "machine-1",
      login: "work",
      logins: [{ name: "work", url: "https://git.example/", user: "alice" }],
    });
    await harness.behavior.callRpc("repos", {
      login: "work",
      hostId: "machine-2",
    });
    assert.equal(calls.at(-1)?.hostId, "machine-2");
    await assert.rejects(
      harness.behavior.callRpc("items", {
        login: "work",
        repo: "../bad",
        kind: "pulls",
      }),
    );
  } finally {
    await harness.lifecycle.dispose();
  }
});
test("CLI help, strict argument validation, defaults and host routing", async () => {
  const { bb, harness, calls } = setup();
  try {
    await plugin(bb);
    const help = await harness.behavior.runCli(["prs", "--help"]);
    assert.equal(help.exitCode, 0);
    assert.match(help.stdout ?? "", /--state/);
    const result = await harness.behavior.runCli([
      "prs",
      "a/b",
      "--json",
      "--page",
      "2",
      "--machine",
      "machine-2",
    ]);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout ?? ""), []);
    assert.equal(calls.at(-1)?.hostId, "machine-2");
    assert.equal((calls.at(-1)?.input as { page: number }).page, 2);
    for (const argv of [
      ["prs"],
      ["prs", "a/b", "--unknown"],
      ["prs", "a/b", "--page", "1.5"],
      ["view", "a/b", "-1"],
    ])
      assert.notEqual((await harness.behavior.runCli(argv)).exitCode, 0);
  } finally {
    await harness.lifecycle.dispose();
  }
});
test("settings changes apply without reload", async () => {
  const { bb, harness, calls } = setup();
  try {
    await plugin(bb);
    await harness.behavior.setSettings({
      hostId: "changed",
      login: "changed-login",
    });
    await harness.behavior.runCli(["repos", "--json"]);
    assert.equal(calls.at(-1)?.hostId, "changed");
    assert.equal(
      (calls.at(-1)?.input as { login: string }).login,
      "changed-login",
    );
  } finally {
    await harness.lifecycle.dispose();
  }
});
test("host contract rejects invalid input before invoking tea", async () => {
  const h = experimental_createHostEntryHarness(hostEntry);
  try {
    await assert.rejects(
      h.experimental_call("detail", {
        login: "work",
        repo: "../bad",
        kind: "issues",
        number: 1,
      }),
    );
  } finally {
    await h.experimental_dispose();
  }
});
test("plugin uses public SDK only", () => {
  const result = experimental_scanPublicSdkOnly(
    new URL(".", import.meta.url).pathname,
    { allow: [/^react$/, /^jsdom$/, /^@testing-library\/react$/] },
  );
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.privateDependencies, []);
});
test("automatic machine selection requires exactly one connected machine", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "oddship-gitea",
    experimental_hostEntry: true,
    settings: { login: "work" },
    sdk: { hosts: { list: async () => [] } },
  });
  try {
    await plugin(bb);
    await assert.rejects(
      harness.behavior.callRpc("connection", null),
      /hostId|machine/,
    );
  } finally {
    await harness.lifecycle.dispose();
  }
});
