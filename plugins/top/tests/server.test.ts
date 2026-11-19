import { expect, it } from "vitest";
import {
  createFakePluginHost,
  makeHostResponse,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
const hostId = "host_test123456";
const threadId = "thr_test123456";
const sessionId = "01a1e382-2ee8-7df1-bfd4-e012565c6e40";
const sample = {
  at: 100,
  intervalMs: 2000,
  cores: 8,
  cpu: 20,
  totalMemory: 1000000,
  availableMemory: 500000,
  scanned: 2,
  unreadable: 0,
  unattributed: 1,
  truncated: false,
  threads: [
    {
      id: threadId,
      cpu: 25,
      rss: 10000,
      count: 1,
      processes: [{ pid: 20, ppid: 1, name: "node", cpu: 25, rss: 10000 }],
    },
  ],
};

it("routes the selected machine, resolves titles, and keeps sampling read only", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "top",
    sdk: {
      hosts: {
        list: async () => [
          makeHostResponse({
            id: hostId,
            name: "Test machine",
            status: "connected",
          }),
        ],
      },
      threads: {
        list: async () =>
          [
            { ...makeThreadResponse({ id: threadId, providerId: "codex" }) },
          ] as never,
        events: {
          list: async () => [
            {
              id: "evt_test",
              seq: 10,
              createdAt: 100,
              threadId,
              scope: { kind: "thread" },
              type: "thread/identity",
              data: { providerThreadId: sessionId },
            },
          ],
        },
        get: async () =>
          makeThreadResponse({ id: threadId, title: "Build the app" }),
      },
    },
    experimental_callHostRpc: async () => sample,
  });
  plugin(bb);
  try {
    const view = await harness.behavior.callRpc("snapshot", { hostId });
    expect(view).toMatchObject({
      hostId,
      hostName: "Test machine",
      threads: [{ title: "Build the app" }],
    });
    expect(harness.experimental_hostRpcCalls[0]).toMatchObject({
      hostId,
      method: "sample",
      input: { sessionOwners: [{ threadId, sessionId }] },
    });
    const output = await harness.behavior.runCli([
      "status",
      "--machine",
      hostId,
      "--json",
    ]);
    expect(output.exitCode).toBe(0);
    expect(JSON.parse(output.stdout!)).toMatchObject({ hostId });
    expect(harness.inspection.sdk.callsTo("threads.get")).toHaveLength(1);
    expect(harness.inspection.sdk.callsTo("threads.list")).toHaveLength(1);
    await expect(
      harness.behavior.callRpc("snapshot", { hostId: "unknown" }),
    ).rejects.toThrow();
    expect(
      (await harness.behavior.runCli(["status", "--machine"])).exitCode,
    ).toBe(1);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("does not fall back when a chosen machine is disconnected", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "top",
    sdk: {
      hosts: {
        list: async () => [
          makeHostResponse({ id: hostId, status: "disconnected" }),
        ],
      },
    },
  });
  plugin(bb);
  try {
    await expect(
      harness.behavior.callRpc("snapshot", { hostId }),
    ).rejects.toThrow("disconnected");
    expect(harness.experimental_hostRpcCalls).toHaveLength(0);
  } finally {
    await harness.lifecycle.dispose();
  }
});
