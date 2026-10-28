// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { normalizeItem } from "../model";

const repo = "gitlab.example.com/team/project";
const item = normalizeItem(
  {
    iid: 7,
    title: "Fix ordering",
    description: "Repro steps",
    web_url: "https://gitlab.example.com/team/project/-/issues/7",
    state: "opened",
    author: { username: "alex" },
    assignees: [],
    labels: ["bug"],
    updated_at: "2026-10-28T00:00:00Z",
  },
  repo,
  "issue",
);
const app = await loadPluginApp(() => import("../app"));
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});
function mount(subPath = "", overrides = {}) {
  const comment = vi.fn(async () => ({ ok: true })),
    startWork = vi.fn(async () => ({ threadId: "new-thread" }));
  const detail = vi.fn(async () => ({ item, notes: [] }));
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath },
    {
      rpc: {
        repos: () => ({ repos: [{ repo, projectId: null }] }),
        list: () => ({
          items: [item],
          total: 1,
          hasMore: false,
          syncedAt: null,
          errors: [],
        }),
        status: () => ({
          host: "gitlab.example.com",
          username: "alex",
          error: null,
        }),
        detail,
        comment,
        startWork,
        ...overrides,
      },
    },
  );
  cleanup.push(() => slot.lifecycle.unmount());
  return { slot, comment, detail, startWork };
}
it("renders cached items and navigates to an issue", async () => {
  const { slot } = mount();
  await slot.findByText("Fix ordering");
  fireEvent.click(slot.getByText("Fix ordering"));
  expect(JSON.stringify(slot.inspection.navigateCalls)).toContain(
    "issue/gitlab.example.com/team/project/7",
  );
});
it("posts a comment once and refreshes its detail", async () => {
  const { slot, comment, detail } = mount(
    `issue/${repo}/7`,
  );
  await slot.findByRole("heading", { name: "Fix ordering" });
  fireEvent.change(slot.getByLabelText("Add a comment"), {
    target: { value: "Checked the fix" },
  });
  fireEvent.click(slot.getByRole("button", { name: "Post comment" }));
  await waitFor(() => expect(comment).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(detail).toHaveBeenCalledTimes(2));
  expect(comment.mock.calls[0][0]).toMatchObject({
    repo,
    kind: "issue",
    number: 7,
    body: "Checked the fix",
  });
});
it("starts agent work and opens the returned BB thread", async () => {
  const { slot, startWork } = mount(`issue/${repo}/7`);
  await slot.findByRole("heading", { name: "Fix ordering" });
  fireEvent.click(slot.getByRole("button", { name: "Start work" }));
  await waitFor(() => expect(startWork).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(JSON.stringify(slot.inspection.navigateCalls)).toContain(
      "new-thread",
    ),
  );
});
it("shows an actionable empty state when no repositories are configured", async () => {
  const { slot } = mount("", {
    repos: () => ({ repos: [] }),
    list: () => ({
      items: [],
      total: 0,
      hasMore: false,
      syncedAt: null,
      errors: [],
    }),
  });
  await slot.findByText(/Extra repositories/);
  expect(
    slot.getByRole("button", { name: "New issue" }).hasAttribute("disabled"),
  ).toBe(true);
});
it("handles invalid deep links without loading or mutating an item", async () => {
  const { slot, detail, comment } = mount("issue/bad/not-a-number");
  await slot.findByText("Invalid GitLab item link.");
  expect(detail).not.toHaveBeenCalled();
  expect(comment).not.toHaveBeenCalled();
});

it('creates an issue in the selected repository', async () => {
  const createIssue = vi.fn(async () => item);
  const { slot } = mount('', { createIssue });
  await slot.findByText('Fix ordering');
  fireEvent.change(slot.getByLabelText('Repository'), { target: { value: repo } });
  fireEvent.click(slot.getByRole('button', { name: 'New issue' }));
  fireEvent.change(slot.getByLabelText('Issue title'), { target: { value: 'New bug' } });
  fireEvent.change(slot.getByLabelText('Issue description'), { target: { value: 'Steps to reproduce' } });
  fireEvent.click(slot.getByRole('button', { name: 'Create issue' }));
  await waitFor(() => expect(createIssue).toHaveBeenCalledTimes(1));
  expect(createIssue.mock.calls[0][0]).toMatchObject({ repo, title: 'New bug', body: 'Steps to reproduce' });
});
