import test from "node:test";
import assert from "node:assert/strict";
import {
  createFakePluginHost,
  makeHostResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";
import type { Resource } from "./lifecycle.js";
test("explicit retirement clears only removed local setup and lets core cleanup finish offline", async () => {
  let connected = true;
  const r: Resource = {
    version: 1,
    key: "old-local",
    owner: "owner",
    endpoint: "http://127.0.0.1:1323",
    account: "old-account",
    name: "old-vm",
    client: "client",
    vmId: "vm",
    phase: "allocated",
    enrolled: true,
    transport: {
      host: "localhost",
      port: 2224,
      fingerprint: "pin",
      identityFile: "old-key",
    },
  };
  const remote = {
    ...r,
    key: "remote",
    endpoint: "https://remote.example.com",
  };
  const { bb, harness } = createFakePluginHost({
    pluginId: "dummie",
    settings: {
      token: "local-secret",
      remoteToken: "remote-secret",
      remoteControlUrl: "https://remote.example.com",
      remoteHost: "remote-host",
      host: "local-host",
    },
    machineResource: async () => r,
    sdk: {
      hosts: {
        list: async () => [
          makeHostResponse({
            id: "host_old",
            machineProviderId: "dummie",
            status: connected ? "connected" : "disconnected",
          }),
        ],
      },
    },
  });
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw Error("No network allowed");
  };
  try {
    await bb.storage.kv.set("owner", "owner");
    await bb.storage.kv.set("intent:" + r.key, r);
    await bb.storage.kv.set("intent:" + remote.key, remote);
    await plugin(bb);
    assert.equal((await harness.behavior.runCli(["retire-local"])).exitCode, 1);
    assert.equal(
      (await harness.behavior.runCli(["retire-local", "--yes"])).exitCode,
      1,
    );
    assert.equal(
      (await bb.storage.kv.get<Resource>("intent:" + r.key))!.phase,
      "allocated",
    );
    connected = false;
    assert.equal(
      (await harness.behavior.runCli(["retire-local", "--yes"])).exitCode,
      0,
    );
    assert.equal(
      (await bb.storage.kv.get<Resource>("intent:" + r.key))!.phase,
      "removed",
    );
    assert.deepEqual(await bb.storage.kv.get("intent:" + remote.key), remote);
    const cfg = (await harness.behavior.callRpc("connections", null)) as {
      active: string;
      profiles: { id: string; credentialsConfigured: boolean }[];
    };
    assert.equal(cfg.active, "remote");
    assert.equal(
      cfg.profiles.some((p) => p.id === "local"),
      false,
    );
    assert.equal(
      cfg.profiles.find((p) => p.id === "remote")!.credentialsConfigured,
      true,
    );
    const p = harness.inspection.registrations.machineProviders.get("dummie")!;
    assert.equal(
      (
        await p.remove({
          hostId: "host_old",
          resource: r,
          signal: AbortSignal.timeout(1000),
          report: { step() {}, log() {} },
        })
      ).status,
      "removed",
    );
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = original;
    await harness.lifecycle.dispose();
  }
});
test("retirement rejects a remote control origin", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "dummie",
    settings: { controlUrl: "https://remote.example.com" },
  });
  try {
    await plugin(bb);
    const result = await harness.behavior.runCli(["retire-local", "--yes"]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr!, /loopback/);
  } finally {
    await harness.lifecycle.dispose();
  }
});
