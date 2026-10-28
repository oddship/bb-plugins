import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://bb.example/",
});
Object.defineProperty(globalThis, "window", {
  value: dom.window,
  configurable: true,
});
Object.defineProperty(globalThis, "document", {
  value: dom.window.document,
  configurable: true,
});
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
Object.assign(globalThis, {
  HTMLElement: dom.window.HTMLElement,
  MutationObserver: dom.window.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { loadPluginApp, renderSlot } =
  await import("@get-bb/plugin-sdk/testing/app");
const { fireEvent, waitFor } = await import("@testing-library/react");
const { act } = await import("react");
const item = {
  number: 7,
  title: "Fix login",
  body: "Issue details <script>bad()</script>",
  url: "https://git.example/a/b/pulls/7",
  state: "open",
  author: "alice",
  updatedAt: "",
  labels: ["bug"],
  head: "fix",
  base: "main",
  merged: false,
};
test("Gitea navigation reads details and drafts an agent task without sending it", async () => {
  const app = await loadPluginApp(() => import("./app.js"));
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        connection: () => ({
          hostId: "m1",
          login: "work",
          logins: [
            { name: "work", url: "https://git.example/", user: "alice" },
          ],
        }),
        repos: () => [
          { name: "a/b", url: "https://git.example/a/b", description: "" },
        ],
        items: () => [item],
        detail: () => ({ item, comments: [] }),
      },
      context: { projectId: "project-1", threadId: null },
    },
  );
  try {
    await waitFor(() => assert.ok(slot.getByRole("option", { name: "a/b" })));
    await act(async () => {
      fireEvent.change(slot.getByLabelText("Repository"), {
        target: { value: "a/b" },
      });
    });
    await slot.findByText("Fix login");
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: /Fix login/ }));
    });
    await slot.findByText(item.body);
    assert.equal(document.querySelector("script"), null);
    await act(async () => {
      fireEvent.click(
        slot.getByRole("button", { name: "Work on this with an agent" }),
      );
    });
    assert.match(JSON.stringify(slot.inspection.navigateCalls), /toCompose/);
    assert.match(JSON.stringify(slot.inspection.navigateCalls), /project-1/);
  } finally {
    slot.lifecycle.unmount();
  }
});
test("frontend displays connection failure and offers Refresh", async () => {
  const app = await loadPluginApp(() => import("./app.js"));
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        connection: () => {
          throw new Error("tea is missing");
        },
      },
    },
  );
  try {
    await slot.findByText("tea is missing");
    assert.ok(slot.getByRole("button", { name: "Refresh" }));
  } finally {
    slot.lifecycle.unmount();
  }
});
test("late results from a previous repository cannot replace current results", async () => {
  let finish: (value: unknown) => void = () => {};
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const app = await loadPluginApp(() => import("./app.js"));
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        connection: () => ({
          hostId: "m1",
          login: "work",
          logins: [
            { name: "work", url: "https://git.example/", user: "alice" },
          ],
        }),
        repos: () => [
          { name: "a/b", url: "https://git.example/a/b", description: "" },
          { name: "a/c", url: "https://git.example/a/c", description: "" },
        ],
        items: (input: unknown) =>
          (input as { repo: string }).repo === "a/b"
            ? pending
            : [{ ...item, title: "Current repository" }],
      },
    },
  );
  try {
    await waitFor(() => assert.ok(slot.getByRole("option", { name: "a/b" })));
    await act(async () => {
      fireEvent.change(slot.getByLabelText("Repository"), {
        target: { value: "a/b" },
      });
    });
    await act(async () => {
      fireEvent.change(slot.getByLabelText("Repository"), {
        target: { value: "a/c" },
      });
    });
    await slot.findByText("Current repository");
    await act(async () => {
      finish([item]);
      await pending;
    });
    assert.equal(slot.queryByText("Fix login"), null);
    assert.ok(slot.getByText("Current repository"));
  } finally {
    slot.lifecycle.unmount();
  }
});
