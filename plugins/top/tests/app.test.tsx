// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { View } from "../contract";
import appDefinition from "../app";
afterEach(() => {
  localStorage.clear();
});
const sample: View = {
  at: Date.now(),
  intervalMs: 2000,
  cores: 8,
  cpu: 20,
  totalMemory: 8000000000,
  availableMemory: 4000000000,
  scanned: 12,
  unreadable: 1,
  unattributed: 10,
  truncated: false,
  hostId: "host_one",
  hostName: "Laptop",
  threads: [
    {
      id: "thr_build12345",
      title: "Build frontend",
      projectId: "proj_test",
      status: "active",
      cpu: 40,
      rss: 104857600,
      count: 2,
      processes: [{ pid: 123, ppid: 1, name: "node", cpu: 40, rss: 104857600 }],
    },
  ],
};

it("requires a machine choice, shows processes, filters, pauses and opens threads", async () => {
  const app = await loadPluginApp(async () => appDefinition);
  const snapshot = vi.fn(async () => sample);
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        machines: () => [
          { id: "host_one", name: "Laptop", status: "connected" },
          { id: "host_two", name: "Server", status: "connected" },
        ],
        snapshot,
      },
    },
  );
  try {
    await slot.findByText("Choose the machine you want to monitor.");
    expect(snapshot).not.toHaveBeenCalled();
    fireEvent.change(slot.getByLabelText("Machine"), {
      target: { value: "host_one" },
    });
    await slot.findByText("Build frontend");
    expect(snapshot).toHaveBeenCalledWith({ hostId: "host_one" });
    fireEvent.click(slot.getByText("Pause"));
    expect(slot.getByText("Paused")).toBeTruthy();
    fireEvent.click(slot.getByText("Build frontend"));
    expect(slot.getByText("123")).toBeTruthy();
    expect(
      slot.getByText(
        "Showing 1 of 2 processes. Totals include all processes in this thread.",
      ),
    ).toBeTruthy();
    fireEvent.click(slot.getByText("Open thread"));
    expect(slot.inspection.navigateCalls).toEqual(
      expect.arrayContaining([expect.objectContaining({ method: "toThread" })]),
    );
    fireEvent.change(slot.getByLabelText("Filter threads"), {
      target: { value: "unmatched" },
    });
    expect(slot.getByText("No threads match your filter.")).toBeTruthy();
    fireEvent.change(slot.getByLabelText("Filter threads"), {
      target: { value: "" },
    });
    fireEvent.click(slot.getByText("Resume"));
    await waitFor(() => expect(snapshot.mock.calls.length).toBeGreaterThan(1));
  } finally {
    slot.lifecycle.unmount();
  }
});

it("surfaces a machine read failure without showing an empty successful sample", async () => {
  const app = await loadPluginApp(async () => appDefinition);
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        machines: () => [
          { id: "host_one", name: "Laptop", status: "connected" },
        ],
        snapshot: () => {
          throw new Error("Machine disconnected");
        },
      },
    },
  );
  try {
    await slot.findByRole("alert");
    expect(slot.getByText("Unable to read this machine.")).toBeTruthy();
  } finally {
    slot.lifecycle.unmount();
  }
});
