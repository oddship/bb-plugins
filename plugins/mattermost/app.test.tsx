// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import {
  loadPluginApp,
  renderSlot as renderSdkSlot,
} from "@get-bb/plugin-sdk/testing/app";
import type { ComponentType } from "react";
function renderSlot<Props extends object>(
  registration: { component: ComponentType<Props> },
  props: Props,
  options: Parameters<typeof renderSdkSlot>[2] = {},
) {
  return renderSdkSlot(registration, props, {
    ...options,
    rpc: { stars: () => [], ...options?.rpc },
  });
}
afterEach(() => {
  cleanup();
  localStorage.clear();
});
const post = {
  id: "a".repeat(26),
  thread_id: "b".repeat(26),
  author: "@coworker",
  message: "Work update",
  created_at: "2026-10-27T10:00:00Z",
  channel: "Work",
};
test("sidebar opens a thread then unread channel using the channel ID", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        read: ({ kind }: any) => ({
          fetchedAt: post.created_at,
          data:
            kind === "unread"
              ? [
                  {
                    channel_id: "c".repeat(26),
                    channel: "Unread work",
                    unread: 3,
                  },
                ]
              : kind === "messages"
                ? [{ ...post, message: "Channel history" }]
                : [post],
        }),
      },
    },
  );
  await slot.findByText("Work update");
  fireEvent.click(slot.getByText("Read conversation"));
  await slot.findByText("Conversation · Work");
  fireEvent.click(slot.getByText("Unread"));
  fireEvent.click(await slot.findByText("Unread work · 3 unread"));
  await slot.findByText("Channel history");
  expect(
    slot.inspection.rpcCalls.some(
      (c) => c.method === "read" && (c.input as any).target === "c".repeat(26),
    ),
  ).toBe(true);
  slot.lifecycle.unmount();
});
test("failed request can be retried", async () => {
  let failed = true;
  const app = await loadPluginApp(() => import("./app"));
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        read: () => {
          if (failed) throw new Error("Host offline");
          return { fetchedAt: post.created_at, data: [post] };
        },
      },
    },
  );
  await slot.findByRole("alert");
  failed = false;
  fireEvent.click(slot.getByText("Try again"));
  await slot.findByText("Work update");
  slot.lifecycle.unmount();
});

test("quoting appends source context to the correct thread draft without submitting", async () => {
  localStorage.clear();
  const app = await loadPluginApp(() => import("./app"));
  const slot = renderSlot(
    app.tabs[0]! as any,
    { threadId: "thr_quote" },
    {
      settings: { hostId: "host-quote" },
      composer: {
        text: "Please investigate.",
        scope: { kind: "thread", threadId: "thr_quote" },
      },
      rpc: {
        context: () => ({
          threadId: "thr_quote",
          title: "Fix order exits",
          suggestedQuery: "order exits",
          links: [],
        }),
        read: () => ({
          fetchedAt: post.created_at,
          data: [post],
          cache: "fresh",
          refreshing: false,
        }),
      },
    },
  );
  await slot.findByText("Work update");
  fireEvent.click(slot.getByText("Quote in BB"));
  expect(slot.inspection.composer.text).toContain("Please investigate.");
  expect(slot.inspection.composer.text).toContain("> Work update");
  expect(slot.inspection.composer.text).toContain("Post: " + post.id);
  expect(slot.inspection.composer.submits).toHaveLength(0);
  slot.lifecycle.unmount();
});

test("links are explicitly saved against this thread and shown in context", async () => {
  localStorage.clear();
  const app = await loadPluginApp(() => import("./app"));
  let links: any[] = [];
  const slot = renderSlot(
    app.tabs[0]! as any,
    { threadId: "thr_links" },
    {
      settings: { hostId: "host-links" },
      rpc: {
        context: () => ({
          threadId: "thr_links",
          title: "Fix order exits",
          suggestedQuery: "order exits",
          links,
        }),
        read: () => ({
          fetchedAt: post.created_at,
          data: [post],
          cache: "fresh",
        }),
        link: ({ conversationId, title, remove }: any) => {
          links = remove
            ? []
            : [{ conversationId, title, createdAt: post.created_at }];
          return links;
        },
      },
    },
  );
  await slot.findByText("Work update");
  fireEvent.click(slot.getByText("Link"));
  await slot.findByText("This thread · 1");
  expect(
    slot.inspection.rpcCalls.some(
      (c) =>
        c.method === "link" &&
        (c.input as any).threadId === "thr_links" &&
        (c.input as any).conversationId === post.thread_id,
    ),
  ).toBe(true);
  fireEvent.click(slot.getByLabelText(/Unlink Work/));
  await slot.findByText("This thread");
  slot.lifecycle.unmount();
});

test("refresh keeps loaded messages visible until the new response arrives", async () => {
  localStorage.clear();
  const app = await loadPluginApp(() => import("./app"));
  let release!: (v: unknown) => void;
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      settings: { hostId: "host-retain" },
      rpc: {
        read: ({ refresh }: any) =>
          refresh
            ? new Promise((resolve) => {
                release = resolve;
              })
            : { fetchedAt: post.created_at, data: [post], cache: "fresh" },
      },
    },
  );
  await slot.findByText("Work update");
  fireEvent.click(slot.getByText("Refresh"));
  expect(slot.getByText("Work update")).toBeTruthy();
  release({
    fetchedAt: post.created_at,
    data: [{ ...post, message: "Fresh update" }],
    cache: "network",
  });
  await slot.findByText("Fresh update");
  slot.lifecycle.unmount();
});

test("search sends a bounded remote search only after submitting", async () => {
  localStorage.clear();
  const app = await loadPluginApp(() => import("./app"));
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      settings: { hostId: "host-search" },
      rpc: {
        read: () => ({
          fetchedAt: post.created_at,
          data: [post],
          cache: "fresh",
        }),
      },
    },
  );
  await slot.findByText("Work update");
  fireEvent.click(slot.getByText("Search"));
  fireEvent.change(slot.getByLabelText("Search Mattermost"), {
    target: { value: "in:work exits" },
  });
  expect(
    slot.inspection.rpcCalls.some((c) => (c.input as any)?.kind === "search"),
  ).toBe(false);
  fireEvent.submit(slot.getByLabelText("Search Mattermost").closest("form")!);
  await slot.findByText("Work update");
  expect(
    slot.inspection.rpcCalls.some(
      (c) => (c.input as any)?.query === "in:work exits",
    ),
  ).toBe(true);
  slot.lifecycle.unmount();
});

test("late channel response does not overwrite a newer mentions view", async () => {
  localStorage.clear();
  const app = await loadPluginApp(() => import("./app"));
  let release!: (v: unknown) => void;
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      settings: { hostId: "host-race" },
      rpc: {
        read: ({ kind }: any) =>
          kind === "channels"
            ? new Promise((resolve) => {
                release = resolve;
              })
            : { fetchedAt: post.created_at, data: [post], cache: "fresh" },
      },
    },
  );
  await slot.findByText("Work update");
  fireEvent.click(slot.getByText("Channels & DMs"));
  // Wait for the request to be dispatched before navigating back.
  await slot.findByText("Loading Mattermost for the first time…");
  fireEvent.click(slot.getByText("Mentions"));
  await slot.findByText("Work update");
  release({
    fetchedAt: post.created_at,
    data: [{ id: "c".repeat(26), name: "Late channel" }],
    cache: "network",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(slot.queryByText("Late channel")).toBeNull();
  expect(slot.getByText("Work update")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("channel conversations collapse replies and preserve the channel filter on back", async () => {
  localStorage.clear();
  const root = {
    ...post,
    id: "r".repeat(26),
    thread_id: "r".repeat(26),
    is_reply: false,
    message: "Original topic",
    reply_count: 2,
  };
  const replies = [
    {
      ...post,
      id: "s".repeat(26),
      thread_id: root.id,
      is_reply: true,
      message: "First response",
      created_at: "2026-10-27T11:00:00Z",
    },
    {
      ...post,
      id: "t".repeat(26),
      thread_id: root.id,
      is_reply: true,
      message: "Latest response",
      created_at: "2026-10-27T12:00:00Z",
    },
  ];
  const app = await loadPluginApp(() => import("./app"));
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      settings: { hostId: "host-grouping" },
      rpc: {
        read: ({ kind }: any) => ({
          fetchedAt: post.created_at,
          cache: "fresh",
          data:
            kind === "channels"
              ? [{ id: "c".repeat(26), name: "Work channel" }]
              : kind === "messages" || kind === "thread"
                ? [root, ...replies]
                : [post],
        }),
      },
    },
  );
  await slot.findByText("Work update");
  fireEvent.click(slot.getByText("Channels & DMs"));
  fireEvent.click(await slot.findByText("Work channel"));
  await slot.findByText("Original topic");
  expect(slot.getAllByText("Read conversation")).toHaveLength(1);
  fireEvent.change(slot.getByLabelText("Filter loaded results"), {
    target: { value: "Latest response" },
  });
  expect(slot.getByText("Original topic")).toBeTruthy();
  fireEvent.click(slot.getByText("Read conversation"));
  await slot.findByLabelText("Original message");
  expect(slot.getAllByLabelText("Reply")).toHaveLength(2);
  fireEvent.click(slot.getByText("← Back"));
  await slot.findByText("Conversations");
  expect(
    (slot.getByLabelText("Filter loaded results") as HTMLInputElement).value,
  ).toBe("Latest response");
  slot.lifecycle.unmount();
});

test("opening a reply highlights it, separates the original and loads earlier replies without blanking", async () => {
  localStorage.clear();
  const root = {
    ...post,
    id: "r".repeat(26),
    thread_id: "r".repeat(26),
    is_reply: false,
    message: "Original topic",
    reply_count: 150,
  };
  const reply = {
    ...post,
    id: "s".repeat(26),
    thread_id: root.id,
    is_reply: true,
    message: "Selected response",
    created_at: "2026-10-27T11:00:00Z",
  };
  const app = await loadPluginApp(() => import("./app"));
  let release!: (result: unknown) => void;
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      settings: { hostId: "host-earlier" },
      rpc: {
        read: ({ kind, limit }: any) =>
          kind === "thread" && limit === 200
            ? new Promise((resolve) => {
                release = resolve;
              })
            : {
                fetchedAt: post.created_at,
                cache: "fresh",
                data: kind === "thread" ? [root, reply] : [reply],
              },
      },
    },
  );
  await slot.findByText("Selected response");
  fireEvent.click(slot.getByText("Read conversation"));
  await slot.findByLabelText("Selected reply");
  expect(slot.getByLabelText("Original message")).toBeTruthy();
  fireEvent.click(slot.getByText("Load earlier replies"));
  expect(slot.getByText("Original topic")).toBeTruthy();
  release({
    fetchedAt: post.created_at,
    cache: "network",
    data: [
      root,
      {
        ...reply,
        id: "u".repeat(26),
        message: "Earlier response",
        created_at: "2026-10-27T10:30:00Z",
      },
      reply,
    ],
  });
  await slot.findByText("Earlier response");
  expect(
    slot.inspection.rpcCalls.some((c) => (c.input as any)?.limit === 200),
  ).toBe(true);
  slot.lifecycle.unmount();
});

test("channel and DM sorting changes order locally and remembers the selection", async () => {
  localStorage.clear();
  const app = await loadPluginApp(() => import("./app"));
  const options = {
    settings: { hostId: "host-sort" },
    rpc: {
      read: ({ kind }: any) => ({
        fetchedAt: post.created_at,
        cache: "fresh",
        data:
          kind === "channels"
            ? [
                {
                  id: "a".repeat(26),
                  name: "Zulu",
                  last_post_at: "2026-10-27T12:00:00Z",
                },
                {
                  id: "b".repeat(26),
                  name: "@alice",
                  type: "DM",
                  last_post_at: "2026-10-20T12:00:00Z",
                },
              ]
            : [post],
      }),
    },
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, options);
  await slot.findByText("Work update");
  fireEvent.click(slot.getByText("Channels & DMs"));
  await slot.findByText("Zulu");
  expect(slot.getAllByRole("listitem")[0].textContent).toContain("Zulu");
  const reads = slot.inspection.rpcCalls.length;
  fireEvent.change(slot.getByLabelText("Sort channels and DMs"), {
    target: { value: "az" },
  });
  expect(slot.getAllByRole("listitem")[0].textContent).toContain("@alice");
  expect(slot.inspection.rpcCalls).toHaveLength(reads);
  slot.lifecycle.unmount();
  const reopened = renderSlot(app.navPanels[0]!, { subPath: "" }, options);
  await reopened.findByText("Zulu");
  expect(
    (reopened.getByLabelText("Sort channels and DMs") as HTMLSelectElement)
      .value,
  ).toBe("az");
  expect(reopened.getAllByRole("listitem")[0].textContent).toContain("@alice");
  reopened.lifecycle.unmount();
});

test("starred conversations reopen from their own view, with pins and no unnecessary message fetch", async () => {
  localStorage.clear();
  const app = await loadPluginApp(() => import("./app"));
  let stars: any[] = [];
  const options = {
    settings: { hostId: "host-star-ui" },
    rpc: {
      stars: () => stars,
      star: ({ conversationId, title, action }: any) => {
        if (action === "unstar") stars = [];
        else
          stars = [
            {
              conversationId,
              title,
              createdAt: post.created_at,
              pinned: action === "pin",
            },
          ];
        return stars;
      },
      read: () => ({
        fetchedAt: post.created_at,
        data: [post],
        cache: "fresh",
      }),
    },
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, options);
  await slot.findByText("Work update");
  fireEvent.click(slot.getByText("Star"));
  await slot.findByText("Unstar");
  fireEvent.click(slot.getByText("Starred"));
  await slot.findByLabelText("Starred conversations");
  fireEvent.click(slot.getByText("Pin"));
  await slot.findByText("Pinned");
  slot.lifecycle.unmount();
  const reopened = renderSlot(app.navPanels[0]!, { subPath: "" }, options);
  await reopened.findByText("Pinned");
  const starReads = reopened.inspection.rpcCalls.filter(
    (call) => call.method === "stars",
  ).length;
  fireEvent.click(reopened.getByText("Refresh"));
  expect(
    reopened.inspection.rpcCalls.filter((call) => call.method === "stars"),
  ).toHaveLength(starReads + 1);
  expect(
    reopened.inspection.rpcCalls.some((call) => call.method === "read"),
  ).toBe(false);
  fireEvent.click(reopened.getByText("Work · Work update"));
  await reopened.findByText("Work update");
  expect(
    reopened.inspection.rpcCalls.some(
      (call) =>
        call.method === "read" && (call.input as any).target === post.thread_id,
    ),
  ).toBe(true);
  reopened.lifecycle.unmount();
});
