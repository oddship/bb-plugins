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
const task = {
  id: "uuid1",
  task_id: "DEV-1",
  project_key: "DEV",
  task_number: 1,
  title: "Fix login",
  description:
    '<p>Task description</p><script>unsafe()</script><a href="javascript:alert(1)">bad link</a>',
  state_name: "Todo",
  state_type: "unstarted",
  priority: 0,
};
test("reads task details and prepares agent draft without a task write", async () => {
  const app = await loadPluginApp(() => import("./app.js"));
  const writes: unknown[] = [];
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      context: { projectId: "p1", threadId: null },
      rpc: {
        connection: () => ({
          hostId: "m1",
          url: "https://tasks.example.com",
          username: "alice",
        }),
        execute: (i: any) => {
          if (i.request.action === "projects")
            return { projects: [], page: 1, total: 0, total_pages: 0 };
          if (i.request.action === "mytasks")
            return { tasks: [task], page: 1, total: 1, total_pages: 1 };
          if (i.request.action === "task") return task;
          writes.push(i);
          return task;
        },
      },
    },
  );
  try {
    await slot.findByText("Fix login");
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: /Fix login/ }));
    });
    await slot.findByText("Task description");
    assert.equal(slot.getByText("bad link").getAttribute("href"), null);
    assert.equal(slot.container.querySelector("script"), null);
    await act(async () => {
      fireEvent.click(
        slot.getByRole("button", { name: "Work on this with an agent" }),
      );
    });
    assert.ok(JSON.stringify(slot.inspection.navigateCalls).includes("DEV-1"));
    assert.equal(writes.length, 0);
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "Edit" }));
    });
    await slot.findByLabelText("Title");
    await act(async () => {
      fireEvent.change(slot.getByLabelText("Title"), {
        target: { value: "Updated title" },
      });
      fireEvent.click(slot.getByRole("button", { name: "Save changes" }));
    });
    await slot.findByText("Task saved.");
    assert.equal(writes.length, 1);
  } finally {
    slot.lifecycle.unmount();
  }
});

test("thread sidebar opens tasks and returns from details to its list", async () => {
  const app = await loadPluginApp(() => import("./app.js"));
  const tab = app.tabs.find(
    (
      t,
    ): t is Extract<
      (typeof app.tabs)[number],
      { context: { kind: "thread" }; availability: "action" }
    > =>
      t.id === "tasks" &&
      t.context.kind === "thread" &&
      t.availability === "action",
  )!;
  assert.equal(tab.availability, "action");
  assert.ok(app.newThreadPanelActions.some((t) => t.id === "tasks"));
  const slot = renderSlot(
    tab,
    { threadId: "t1", params: {} },
    {
      rpc: {
        connection: () => ({
          hostId: "m1",
          url: "https://tasks.example.com",
          username: "alice",
        }),
        execute: (i: any) =>
          i.request.action === "projects"
            ? { projects: [], page: 1, total: 0, total_pages: 0 }
            : i.request.action === "task"
              ? task
              : { tasks: [task], page: 1, total: 1, total_pages: 1 },
      },
    },
  );
  try {
    await slot.findByText("Fix login");
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: /Fix login/ }));
    });
    await slot.findByText("Task description");
    assert.equal(slot.queryByRole("region", { name: "Tasks" }), null);
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "Back to tasks" }));
    });
    await slot.findByRole("region", { name: "Tasks" });
  } finally {
    slot.lifecycle.unmount();
  }
});

test("filter and sort controls send complete requests and reset pagination", async () => {
  const app = await loadPluginApp(() => import("./app.js"));
  const reads: any[] = [];
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        connection: () => ({
          hostId: "m1",
          url: "https://tasks.example.com",
          username: "alice",
        }),
        execute: (i: any) => {
          reads.push(i.request);
          return i.request.action === "projects"
            ? {
                projects: [
                  { id: "p1", project_key: "DEV", name: "Development" },
                ],
                page: 1,
                total: 1,
                total_pages: 1,
              }
            : {
                tasks: [task],
                page: i.request.page,
                total: 60,
                total_pages: 2,
              };
        },
      },
    },
  );
  try {
    await slot.findByText("Fix login");
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "Next" }));
    });
    await waitFor(() =>
      assert.ok(reads.some((r) => r.action === "mytasks" && r.page === 2)),
    );
    await act(async () => {
      fireEvent.change(slot.getByLabelText("Filter priority"), {
        target: { value: "0" },
      });
      fireEvent.change(slot.getByLabelText("Search tasks"), {
        target: { value: "login" },
      });
    });
    await act(async () => {
      fireEvent.change(slot.getByLabelText("Sort tasks"), {
        target: { value: "title" },
      });
    });
    await waitFor(() => assert.ok(reads.some((r) => r.sort === "title")));
    assert.equal(
      (slot.getByLabelText("Filter priority") as HTMLSelectElement).value,
      "0",
    );
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "Apply filters" }));
    });
    await waitFor(() =>
      assert.ok(
        reads.some(
          (r) =>
            r.action === "mytasks" &&
            r.page === 1 &&
            r.priority === 0 &&
            r.q === "login",
        ),
      ),
    );
    await act(async () => {
      fireEvent.change(slot.getByLabelText("Sort tasks"), {
        target: { value: "priority" },
      });
    });
    await waitFor(() =>
      assert.ok(
        reads.some(
          (r) =>
            r.sort === "priority" && r.direction === "desc" && r.priority === 0,
        ),
      ),
    );
    await act(async () => {
      fireEvent.change(slot.getByLabelText("Tasks per page"), {
        target: { value: "100" },
      });
    });
    await waitFor(() =>
      assert.ok(reads.some((r) => r.perPage === 100 && r.page === 1)),
    );
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "Clear filters" }));
    });
    await waitFor(() =>
      assert.ok(
        reads.at(-1).priority === undefined && reads.at(-1).sort === "priority",
      ),
    );
    await act(async () => {
      fireEvent.change(slot.getByLabelText("Project"), {
        target: { value: "DEV" },
      });
    });
    await slot.findByLabelText("Created from");
    await act(async () => {
      fireEvent.change(slot.getByLabelText("Assignee"), {
        target: { value: "alice" },
      });
      fireEvent.change(slot.getByLabelText("Created from"), {
        target: { value: "2026-10-01" },
      });
    });
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "Apply filters" }));
    });
    await waitFor(() =>
      assert.ok(
        reads.some(
          (r) =>
            r.action === "tasks" &&
            r.assignedTo === "alice" &&
            r.fromDate === "2026-10-01",
        ),
      ),
    );
  } finally {
    slot.lifecycle.unmount();
  }
});

test("creation form sends initial workflow state, assignees and labels only on submit", async () => {
  const app = await loadPluginApp(() => import("./app.js"));
  const writes: any[] = [];
  const uuid = "11111111-1111-4111-8111-111111111111";
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        connection: () => ({
          hostId: "m1",
          url: "https://tasks.example.com",
          username: "alice",
        }),
        execute: (i: any) => {
          if (i.request.action === "projects")
            return {
              projects: [{ id: "p1", project_key: "DEV", name: "Development" }],
              page: 1,
              total: 1,
              total_pages: 1,
            };
          if (i.request.action === "task") return task;
          if (i.request.action === "create") {
            writes.push(i.request);
            return task;
          }
          return { tasks: [task], page: 1, total: 1, total_pages: 1 };
        },
      },
    },
  );
  try {
    await slot.findByRole("option", { name: "DEV · Development" });
    await act(async () => {
      fireEvent.change(slot.getByLabelText("Project"), {
        target: { value: "DEV" },
      });
    });
    await slot.findByRole("button", { name: "New task" });
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "New task" }));
    });
    await act(async () => {
      fireEvent.change(slot.getByLabelText("Title"), {
        target: { value: "New task title" },
      });
      fireEvent.change(slot.getByLabelText("Edit workflow state ID"), {
        target: { value: uuid },
      });
      fireEvent.change(slot.getByLabelText("Initial assignee IDs"), {
        target: { value: uuid },
      });
      fireEvent.change(slot.getByLabelText("Initial label IDs"), {
        target: { value: uuid },
      });
    });
    assert.equal(writes.length, 0);
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "Create task" }));
    });
    await waitFor(() => assert.equal(writes.length, 1));
    assert.equal(writes[0].stateId, uuid);
    assert.deepEqual(writes[0].assignees, [uuid]);
    assert.deepEqual(writes[0].labels, [uuid]);
  } finally {
    slot.lifecycle.unmount();
  }
});
