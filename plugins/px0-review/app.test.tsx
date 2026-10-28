// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { rpcContract } from "./contract";
import type { ComponentType } from "react";

const viewer = (id: string) => ({
  key: id,
  environmentId: id,
  hostId: "host_test",
  threadId: "thr_test",
  root: `/workspace/${id}`,
  url: `http://127.0.0.1:12345/?px0_token=${id}`,
  port: 12345,
  pid: 100,
  lastUsed: 1,
  fileCount: 1,
});
async function mount(open: () => Promise<ReturnType<typeof viewer>>) {
  const app = await loadPluginApp(() => import("./app"));
  return renderSlot(
    {
      component: app.tabs[0]!.component as ComponentType<{ threadId: string }>,
    },
    { threadId: "thr_test" },
    {
      experimental_rpcContract: rpcContract,
      rpc: {
        open,
        stop: async () => ({ stopped: 1 }),
        feedback: async () => ({ sent: true }),
      },
    },
  );
}
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("clears feedback captured in the previous workspace", async () => {
  vi.useFakeTimers();
  let id = "env_A";
  const panel = await mount(async () => viewer(id));
  await flush();
  const frame = panel.getByTitle("px0 code review") as HTMLIFrameElement;
  act(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        origin: "http://127.0.0.1:12345",
        data: {
          type: "px0:selection",
          path: "old.ts",
          l1: 1,
          l2: 2,
          text: "code from A",
        },
      }),
    ),
  );
  fireEvent.change(panel.getByLabelText("Review feedback"), {
    target: { value: "Fix A" },
  });
  // A normal heartbeat must preserve a draft for the same viewer.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(
    (panel.getByLabelText("Review feedback") as HTMLTextAreaElement).value,
  ).toBe("Fix A");
  id = "env_B";
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(panel.queryByLabelText("Review feedback")).toBeNull();
  expect(panel.getByTitle("px0 code review").getAttribute("src")).toBe(
    viewer(id).url,
  );
  expect(
    panel.inspection.rpcCalls.filter((c) => c.method === "feedback"),
  ).toHaveLength(0);
});

it("ignores heartbeat replies after Stop", async () => {
  vi.useFakeTimers();
  let finish!: (value: ReturnType<typeof viewer>) => void;
  let calls = 0;
  const panel = await mount(async () =>
    ++calls === 1
      ? viewer("env_A")
      : await new Promise<ReturnType<typeof viewer>>((resolve) => {
          finish = resolve;
        }),
  );
  await flush();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000);
  });
  fireEvent.click(panel.getByText("Stop"));
  await flush();
  expect(panel.getByText("Review stopped.")).toBeTruthy();
  await act(async () => {
    finish(viewer("env_A"));
  });
  expect(panel.getByText("Review stopped.")).toBeTruthy();
  expect(panel.queryByTitle("px0 code review")).toBeNull();
});

it("ignores an old open after unmount", async () => {
  let finish!: (value: ReturnType<typeof viewer>) => void;
  const panel = await mount(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await flush();
  panel.lifecycle.unmount();
  await act(async () => {
    finish(viewer("env_A"));
  });
  expect(panel.container.children).toHaveLength(0);
});
