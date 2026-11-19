import test from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createDummiePlugin } from "./server.js";
import { resourceSchema } from "./lifecycle.js";
const vmId = "10000000-0000-4000-8000-000000000001";
test("remote HTTPS enrollment needs no allocation defaults; failure retains disk, retry and profile switch preserve identity", async () => {
  const original = globalThis.fetch;
  const requests: { origin: string; auth: string; method: string }[] = [];
  let bootstrapFail = true;
  let status = "running";
  const vm = () => ({
    id: vmId,
    name: "existing-vm",
    client_id: "client",
    created_by: "remote-account",
    status,
    vm_id: "guest",
    expires_at: "",
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push({
      origin: url.origin,
      auth: new Headers(init?.headers).get("Authorization")!,
      method,
    });
    assert.equal(url.origin, "https://remote.example.com");
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer remote-secret",
    );
    if (url.pathname.endsWith("/me"))
      return Response.json({ id: "remote-account" });
    if (url.pathname.endsWith("/stop")) {
      status = "stopped";
      return Response.json(vm());
    }
    assert.equal(method, "GET", "No allocation/destroy/edit is allowed");
    return Response.json(vm());
  };
  const { bb, harness } = createFakePluginHost({
    pluginId: "dummie",
    settings: {
      connection: "remote",
      remoteControlUrl: "https://remote.example.com",
      remoteToken: "remote-secret",
      token: "local-secret",
      remoteSshFingerprint: "SHA256:" + "A".repeat(43),
    },
    sdk: { hosts: { list: async () => [] } },
    machineBootstrap: {
      async bootstrap() {
        if (bootstrapFail) throw Error("bootstrap failed");
        return { hostId: "host_adopted" };
      },
    },
  });
  try {
    await createDummiePlugin(() => ({ exec: async () => ({ exitCode: 0 }) }))(
      bb,
    );
    const p = harness.inspection.registrations.machineProviders.get("dummie")!;
    const ctx = {
      key: "adoption",
      attempt: 1,
      inputs: {
        existingVmId: vmId,
        expectedName: "existing-vm",
        connection: "remote" as const,
      },
      signal: AbortSignal.timeout(5000),
      report: { step() {}, log() {} },
      checkpoint: async () => {},
    };
    assert.equal((await p.create(ctx)).status, "failed");
    const retained = resourceSchema.parse(
      await bb.storage.kv.get("intent:adoption"),
    );
    assert.equal(retained.adopted, true);
    assert.equal(
      (
        await p.remove({
          hostId: "host_adopted",
          resource: retained,
          report: ctx.report,
          signal: ctx.signal,
        })
      ).status,
      "failed",
    );
    bootstrapFail = false;
    const result = await p.create({ ...ctx, attempt: 2 });
    assert.equal(result.status, "created");
    if (result.status !== "created")
      throw Error("Expected successful enrollment");
    await harness.behavior.setSettings({ connection: "local" });
    await p.suspend!({
      hostId: "host_adopted",
      resource: result.resource,
      signal: ctx.signal,
      report: ctx.report,
      checkpoint: ctx.checkpoint,
    });
    assert.equal(status, "stopped");
    assert.equal(
      (
        await p.remove({
          hostId: "host_adopted",
          resource: result.resource,
          report: ctx.report,
          signal: ctx.signal,
        })
      ).status,
      "removed",
    );
    const publicState = JSON.stringify(
      await harness.behavior.callRpc("connections", null),
    );
    assert.ok(
      !publicState.includes("remote-secret") &&
        !publicState.includes("local-secret"),
    );
    assert.ok(requests.every((r) => r.origin === "https://remote.example.com"));
  } finally {
    globalThis.fetch = original;
    await harness.lifecycle.dispose();
  }
});
test("remote HTTP fails before sending credentials", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "dummie",
    settings: {
      connection: "remote",
      remoteControlUrl: "http://remote.example.com",
      remoteToken: "secret",
    },
  });
  await createDummiePlugin()(bb);
  try {
    const result = await harness.behavior.runCli(["catalog"]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr!, /Use HTTPS/);
  } finally {
    await harness.lifecycle.dispose();
  }
});
