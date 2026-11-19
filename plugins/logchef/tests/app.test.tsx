// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Result } from "../contract";
afterEach(cleanup);
const connection = {
  hostId: "host_one",
  context: "prod",
  machines: [
    { id: "host_one", name: "Laptop", status: "connected" },
    { id: "host_two", name: "Worker", status: "connected" },
  ],
};
const empty: Result = {
  rows: [],
  logs: [],
  count: 0,
  stats: {},
  generatedSql: "",
  truncated: false,
};
const read = (i: any): Result =>
  i.action === "teams"
    ? { ...empty, count: 1, rows: [{ id: "1", name: "Platform", detail: "" }] }
    : i.action === "sources"
      ? {
          ...empty,
          count: 2,
          rows: [
            { id: "2", name: "API logs", detail: "" },
            { id: "3", name: "Worker logs", detail: "" },
          ],
        }
      : {
          ...empty,
          count: 1,
          logs: [
            {
              msg: "Connection failed",
              level: "error",
              _timestamp: "2026-11-19T00:00:00Z",
            },
          ],
        };
async function choose(slot: any) {
  await slot.findByText("Platform");
  fireEvent.change(slot.getByLabelText("Team"), { target: { value: "1" } });
  await slot.findByText("API logs");
  fireEvent.change(slot.getByLabelText("Source"), { target: { value: "2" } });
}
it("loads discovery, runs only explicit queries, and clears results after switching source", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    { rpc: { connection: () => connection, read } },
  );
  await choose(slot);
  expect(
    slot.inspection.rpcCalls.filter(
      (c) => c.method === "read" && (c.input as any).action === "query",
    ),
  ).toHaveLength(0);
  fireEvent.change(slot.getByLabelText("LogChefQL"), {
    target: { value: 'level="error"' },
  });
  fireEvent.click(slot.getByText("Run query"));
  await slot.findByText("Connection failed");
  expect(slot.inspection.rpcCalls.at(-1)?.input).toMatchObject({
    hostId: "host_one",
    context: "prod",
    team: "1",
    source: "2",
    query: 'level="error"',
    limit: 100,
  });
  fireEvent.change(slot.getByLabelText("Source"), { target: { value: "3" } });
  expect(slot.queryByText("Connection failed")).toBeNull();
  slot.lifecycle.unmount();
});
it("quotes evidence into the thread draft without sending", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(
    app.tabs[0]! as any,
    { threadId: "thr_logs" },
    {
      composer: {
        text: "Investigate.",
        scope: { kind: "thread", threadId: "thr_logs" },
      },
      rpc: { connection: () => connection, read },
    },
  );
  await choose(slot);
  fireEvent.click(slot.getByText("Run query"));
  await slot.findByText("Connection failed");
  fireEvent.click(slot.getByText("Quote in draft"));
  expect(slot.inspection.composer.text).toContain("Investigate.");
  expect(slot.inspection.composer.text).toContain("untrusted log content");
  expect(slot.inspection.composer.text).toContain("Connection failed");
  expect(slot.inspection.composer.submits).toHaveLength(0);
  slot.lifecycle.unmount();
});
it("ignores a delayed query response after switching machines", async () => {
  let resolve!: (r: Result) => void;
  const pending = new Promise<Result>((r) => {
    resolve = r;
  });
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        connection: () => connection,
        selectMachine: () => null,
        read: (i: any) => (i.action === "query" ? pending : read(i)),
      },
    },
  );
  await choose(slot);
  fireEvent.click(slot.getByText("Run query"));
  fireEvent.change(slot.getByLabelText("Execution machine"), {
    target: { value: "host_two" },
  });
  await waitFor(() =>
    expect(
      slot.inspection.rpcCalls.some(
        (c) => c.method === "read" && (c.input as any).hostId === "host_two",
      ),
    ).toBe(true),
  );
  await act(async () => {
    resolve(read({ action: "query" }));
    await pending;
  });
  expect(slot.queryByText("Connection failed")).toBeNull();
  slot.lifecycle.unmount();
});
it("shows connection errors and supports retry", async () => {
  let failed = true;
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        connection: () => {
          if (failed) throw new Error("Connection unavailable");
          return connection;
        },
        read,
      },
    },
  );
  await slot.findByRole("alert");
  failed = false;
  fireEvent.click(slot.getByText("Reconnect"));
  await slot.findByText("Platform");
  slot.lifecycle.unmount();
});
