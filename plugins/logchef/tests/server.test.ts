import { expect, it } from "vitest";
import {
  createFakePluginHost,
  makeHostResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
const result = {
  rows: [{ id: "1", name: "Platform", detail: "" }],
  logs: [],
  count: 1,
  stats: {},
  generatedSql: "",
  truncated: false,
};
function setup(settings: Record<string, string> = {}, disconnected = false) {
  const fake = createFakePluginHost({
    pluginId: "logchef",
    settings,
    sdk: {
      hosts: {
        list: async () => [
          makeHostResponse({
            id: "host_one",
            name: "Laptop",
            status: disconnected ? "disconnected" : "connected",
          }),
          makeHostResponse({
            id: "host_two",
            name: "Worker",
            status: "connected",
          }),
        ],
      },
    },
    experimental_callHostRpc: async () => result,
  });
  plugin(fake.bb);
  return fake.harness;
}
it("requires machine selection with multiple hosts", async () => {
  const h = setup();
  try {
    await expect(
      h.behavior.callRpc("read", { action: "teams" }),
    ).rejects.toThrow("Choose an execution machine");
    expect(h.experimental_hostRpcCalls).toHaveLength(0);
  } finally {
    await h.lifecycle.dispose();
  }
});
it("uses saved routing, context and executable for RPC, CLI and tool reads", async () => {
  const h = setup({
    hostId: "host_one",
    context: "work",
    binaryPath: "/opt/logchef",
  });
  try {
    await h.behavior.callRpc("read", { action: "teams" });
    const cli = await h.behavior.runCli(["teams", "--json"]);
    expect(cli.exitCode, JSON.stringify(cli)).toBe(0);
    expect(JSON.parse(cli.stdout!)).toEqual(result);
    await h.behavior.callAgentTool("logchef_read", { action: "teams" });
    expect(h.experimental_hostRpcCalls).toHaveLength(3);
    for (const call of h.experimental_hostRpcCalls)
      expect(call).toMatchObject({
        hostId: "host_one",
        input: { binaryPath: "/opt/logchef", request: { context: "work" } },
      });
  } finally {
    await h.lifecycle.dispose();
  }
});
it("supports machine names and per-call contexts without changing saved defaults", async () => {
  const h = setup({ hostId: "host_one", context: "prod" });
  try {
    const cli = await h.behavior.runCli([
      "sources",
      "--machine",
      "Worker",
      "--context",
      "dev",
      "--team",
      "1",
      "--json",
    ]);
    expect(cli.exitCode, JSON.stringify(cli)).toBe(0);
    expect(h.experimental_hostRpcCalls[0]).toMatchObject({
      hostId: "host_two",
      input: { request: { context: "dev", team: "1" } },
    });
    expect(await h.behavior.callRpc("connection", null)).toMatchObject({
      hostId: "host_one",
      context: "prod",
    });
  } finally {
    await h.lifecycle.dispose();
  }
});
it("refuses disconnected selected machines without fallback", async () => {
  const h = setup({ hostId: "host_one" }, true);
  try {
    await expect(
      h.behavior.callRpc("read", { action: "teams" }),
    ).rejects.toThrow("disconnected");
    expect(h.experimental_hostRpcCalls).toHaveLength(0);
  } finally {
    await h.lifecycle.dispose();
  }
});
it("validates machine changes and persists a valid selection", async () => {
  const h = setup();
  try {
    await expect(
      h.behavior.callRpc("selectMachine", { hostId: "missing" }),
    ).rejects.toThrow();
    await h.behavior.callRpc("selectMachine", { hostId: "host_two" });
    await h.behavior.callRpc("read", { action: "teams" });
    expect(h.experimental_hostRpcCalls[0].hostId).toBe("host_two");
  } finally {
    await h.lifecycle.dispose();
  }
});
it("CLI help and validation do not query LogChef", async () => {
  const h = setup({ hostId: "host_one" });
  try {
    expect((await h.behavior.runCli(["query", "--help"])).exitCode).toBe(0);
    expect((await h.behavior.runCli(["sources", "--json"])).exitCode).toBe(1);
    expect(
      (
        await h.behavior.runCli([
          "query",
          "",
          "--team",
          "1",
          "--source",
          "2",
          "--limit",
          "501",
        ])
      ).exitCode,
    ).toBe(1);
    expect(h.experimental_hostRpcCalls).toHaveLength(0);
  } finally {
    await h.lifecycle.dispose();
  }
});
it("accepts an explicitly empty query as a bounded all-log search", async () => {
  const h = setup({ hostId: "host_one" });
  try {
    const cli = await h.behavior.runCli([
      "query",
      "",
      "--team",
      "1",
      "--source",
      "2",
      "--json",
    ]);
    expect(cli.exitCode, JSON.stringify(cli)).toBe(0);
    expect(h.experimental_hostRpcCalls[0]).toMatchObject({
      input: { request: { query: "", limit: 100, since: "15m" } },
    });
  } finally {
    await h.lifecycle.dispose();
  }
});
