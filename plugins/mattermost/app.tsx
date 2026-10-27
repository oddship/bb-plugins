import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useRpc,
  useRealtime,
  useComposer,
  useBbNavigate,
  Markdown,
  UrlLink,
  useSettings,
  experimental_copyToClipboard,
} from "@get-bb/plugin-sdk/app";
import type {
  rpcContract,
  Channel,
  Post,
  Request,
  ThreadContext,
  ReadResult,
} from "./contract";
import {
  groupConversations,
  splitThread,
  conversationId as getConversationId,
} from "./threading";
import { sortChannels, channelSortOptions, type ChannelSort } from "./channels";
import { quotePosts } from "./context";
import { useMattermost } from "./use-mattermost";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
type View = "context" | "mentions" | "unread" | "channels" | "search";
type Selection = {
  kind: "messages" | "thread";
  target: string;
  title: string;
  focusPostId?: string;
};
type Frame = {
  selection: Selection | null;
  filter: string;
  scrollTop: number;
  limit: 100 | 200 | 500 | 1000;
};

const date = (s: string) => new Date(s).toLocaleString();
const age = (s: string) => {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(s)) / 60000));
  return minutes < 1
    ? "just now"
    : minutes < 60
      ? minutes + "m ago"
      : minutes < 1440
        ? Math.floor(minutes / 60) + "h ago"
        : Math.floor(minutes / 1440) + "d ago";
};
const savedKey = (threadId: string | null) =>
  "mattermost:view:" + (threadId ?? "inbox");
const validSelection = (value: unknown): value is Selection => {
  if (!value || typeof value !== "object") return false;
  const v = value as Selection;
  return (
    ["thread", "messages"].includes(v.kind) &&
    typeof v.target === "string" &&
    /^[a-z0-9]{26}$/.test(v.target) &&
    typeof v.title === "string" &&
    v.title.length <= 250 &&
    (!v.focusPostId || /^[a-z0-9]{26}$/.test(v.focusPostId))
  );
};
function savedView(threadId: string | null): {
  view: View;
  selection: Selection | null;
  trail: Frame[];
  query: string;
  search: string;
} {
  const empty = {
    view: threadId ? ("context" as View) : ("mentions" as View),
    selection: null,
    trail: [],
    query: "",
    search: "",
  };
  try {
    const data = JSON.parse(localStorage.getItem(savedKey(threadId)) ?? "null");
    if (
      !data ||
      !["context", "mentions", "unread", "channels", "search"].includes(
        data.view,
      ) ||
      (data.selection && !validSelection(data.selection))
    )
      return empty;
    const trail: Array<Frame> = Array.isArray(data.trail)
      ? data.trail
          .filter(
            (f: Frame) =>
              f &&
              (!f.selection || validSelection(f.selection)) &&
              typeof f.filter === "string" &&
              f.filter.length <= 300 &&
              Number.isFinite(f.scrollTop) &&
              f.scrollTop >= 0 &&
              f.scrollTop < 1e7 &&
              [100, 200, 500, 1000].includes(f.limit),
          )
          .slice(-10)
      : [];
    return {
      view: data.view,
      selection: data.selection ?? null,
      trail,
      query: typeof data.query === "string" ? data.query.slice(0, 300) : "",
      search: typeof data.search === "string" ? data.search.slice(0, 300) : "",
    };
  } catch {
    return empty;
  }
}
function MattermostPage({ threadId = null }: { threadId?: string | null }) {
  const rpc = useRpc<typeof rpcContract>(),
    composer = useComposer(),
    navigate = useBbNavigate();
  const { values } = useSettings();
  const serverUrl = String(values?.serverUrl ?? "").replace(/\/$/, "");
  const [channelSort, setChannelSort] = useState<ChannelSort>(() => {
    try {
      const saved = localStorage.getItem("mattermost:channel-sort");
      if (saved && Object.hasOwn(channelSortOptions, saved))
        return saved as ChannelSort;
    } catch {}
    return "recent";
  });
  useEffect(() => {
    try {
      localStorage.setItem("mattermost:channel-sort", channelSort);
    } catch {}
  }, [channelSort]);
  const [initial] = useState(() => savedView(threadId));
  const [view, setView] = useState<View>(initial.view);
  const [selection, setSelection] = useState<Selection | null>(
    initial.selection,
  );
  const [trail, setTrail] = useState<Frame[]>(initial.trail);
  const [threadLimit, setThreadLimit] = useState<100 | 200 | 500 | 1000>(100);
  const [channelMode, setChannelMode] = useState<"threads" | "messages">(
    "threads",
  );
  const scroller = useRef<HTMLDivElement>(null);
  const restoreScroll = useRef<number | null>(null);
  const restoreAnchor = useRef<{ id: string; top: number } | null>(null);
  const previousThread = useRef<{ target: string; result: ReadResult } | null>(
    null,
  );
  const scrolledKey = useRef("");
  const navigationKey = JSON.stringify([
    threadId,
    view,
    selection?.kind,
    selection?.target,
    threadLimit,
  ]);
  const [since, setSince] = useState<"6h" | "1d" | "7d">("1d");
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState(initial.query);
  const [search, setSearch] = useState(initial.search);
  const [context, setContext] = useState<ThreadContext | null>(null);
  const [contextError, setContextError] = useState("");
  const [notice, setNotice] = useState("");
  const [linking, setLinking] = useState(false);
  const fetchContext = useCallback(() => {
    if (!threadId) return;
    rpc.call("context", { threadId }).then(
      (next) => {
        setContext(next);
        setContextError("");
      },
      (cause) =>
        setContextError(
          cause instanceof Error
            ? cause.message
            : "Could not load linked conversations.",
        ),
    );
  }, [rpc, threadId]);
  useEffect(fetchContext, [fetchContext]);
  useRealtime("context-updated", fetchContext);
  useEffect(() => {
    try {
      localStorage.setItem(
        savedKey(threadId),
        JSON.stringify({ view, selection, trail, query, search }),
      );
    } catch {}
  }, [view, selection, threadId, trail, query, search]);
  const request: Request | null = selection
    ? selection.kind === "thread"
      ? {
          kind: "thread",
          target: selection.target,
          ...(threadLimit > 100 ? { limit: threadLimit } : {}),
        }
      : { kind: "messages", target: selection.target }
    : view === "search"
      ? search
        ? { kind: "search", query: search }
        : null
      : view === "channels"
        ? { kind: "channels" }
        : view === "unread"
          ? { kind: "unread" }
          : { kind: "mentions", since };
  const { result: newResult, pending, error, refresh } = useMattermost(request);
  if (newResult && selection?.kind === "thread")
    previousThread.current = { target: selection.target, result: newResult };
  const result =
    newResult ??
    (selection?.kind === "thread" &&
    previousThread.current?.target === selection.target
      ? previousThread.current.result
      : undefined);
  const posts =
    result &&
    Array.isArray(result.data) &&
    !["channels", "unread"].includes(request?.kind ?? "")
      ? (result.data as Post[])
      : [];
  const channels =
    result &&
    Array.isArray(result.data) &&
    ["channels", "unread"].includes(request?.kind ?? "")
      ? (result.data as Channel[])
      : [];
  const thread =
    selection?.kind === "thread" ? splitThread(posts, selection.target) : null;
  const orderedPosts = thread
    ? [...(thread.root ? [thread.root] : []), ...thread.replies]
    : posts;
  const groups =
    selection?.kind === "messages" && channelMode === "threads"
      ? groupConversations(posts)
      : [];
  const matchingGroups = groups.filter((g) =>
    g.posts.some((p) =>
      (p.author + " " + p.message).toLowerCase().includes(filter.toLowerCase()),
    ),
  );
  const displayedPosts = groups.length
    ? matchingGroups.map((g) => g.preview)
    : orderedPosts;
  const visiblePosts = groups.length
    ? displayedPosts
    : displayedPosts.filter(
        (p) =>
          thread?.root === p ||
          (p.author + " " + (p.channel ?? "") + " " + p.message)
            .toLowerCase()
            .includes(filter.toLowerCase()),
      );
  const filteredChannels = channels.filter((c) =>
    ((c.name ?? c.channel ?? "") + " " + (c.team ?? "") + " " + (c.type ?? ""))
      .toLowerCase()
      .includes(filter.toLowerCase()),
  );
  const visibleChannels =
    view === "channels"
      ? sortChannels(filteredChannels, channelSort)
      : filteredChannels;
  const open = (next: Selection) => {
    const currentScroll = scroller.current?.scrollTop ?? 0;
    setTrail((t) =>
      [
        ...t,
        { selection, filter, scrollTop: currentScroll, limit: threadLimit },
      ].slice(-10),
    );
    restoreScroll.current = next.focusPostId ? null : 0;
    setThreadLimit(100);
    setSelection(next);
    setFilter("");
    setNotice("");
  };
  const choose = (next: View) => {
    restoreScroll.current = 0;
    setThreadLimit(100);
    setView(next);
    setSelection(null);
    setTrail([]);
    setFilter("");
    setNotice("");
  };
  const addToDraft = (selected: Post[], title: string) => {
    composer.insert(quotePosts(selected, title), { at: "end", block: true });
    composer.focus();
    setNotice("Context added to your draft. Review it before sending.");
  };
  const draftTask = (selected: Post[], title: string) => {
    navigate.toCompose({
      initialPrompt:
        "Investigate this work conversation and propose the next steps.\n\n" +
        quotePosts(selected, title),
      focusPrompt: true,
    });
  };
  const link = async (
    conversationId: string,
    title: string,
    remove = false,
  ) => {
    if (!threadId || linking) return;
    setLinking(true);
    setNotice("");
    try {
      const links = await rpc.call("link", {
        threadId,
        conversationId,
        title: title.slice(0, 180),
        remove,
      });
      setContext((previous) => (previous ? { ...previous, links } : previous));
      setNotice(
        remove
          ? "Conversation unlinked."
          : "Linked to this BB thread. The agent can retrieve it with mattermost_context.",
      );
    } catch (cause) {
      setNotice(
        cause instanceof Error ? cause.message : "Could not update link.",
      );
    } finally {
      setLinking(false);
    }
  };
  useEffect(() => {
    if (!newResult || scrolledKey.current === navigationKey) return;
    const node = scroller.current;
    scrolledKey.current = navigationKey;
    if (restoreAnchor.current && node) {
      const anchor = Array.from(
        node.querySelectorAll<HTMLElement>("[data-post-id]"),
      ).find((el) => el.dataset.postId === restoreAnchor.current!.id);
      if (anchor) {
        node.scrollTop +=
          anchor.getBoundingClientRect().top - restoreAnchor.current.top;
        restoreAnchor.current = null;
        restoreScroll.current = null;
        return;
      }
      restoreAnchor.current = null;
    }
    if (restoreScroll.current !== null && node) {
      node.scrollTop = restoreScroll.current;
      restoreScroll.current = null;
      return;
    }
    if (selection?.kind === "thread" && selection.focusPostId) {
      const element = Array.from(
        node?.querySelectorAll<HTMLElement>("[data-post-id]") ?? [],
      ).find((el) => el.dataset.postId === selection.focusPostId);
      element?.scrollIntoView?.({ block: "center" });
    }
  }, [newResult, selection, navigationKey]);
  const moreReplies = () => {
    const node = scroller.current;
    const anchor =
      node &&
      Array.from(node.querySelectorAll<HTMLElement>("[data-post-id]")).find(
        (el) =>
          el.getBoundingClientRect().bottom > node.getBoundingClientRect().top,
      );
    if (anchor?.dataset.postId)
      restoreAnchor.current = {
        id: anchor.dataset.postId,
        top: anchor.getBoundingClientRect().top,
      };
    restoreScroll.current = scroller.current?.scrollTop ?? 0;
    setThreadLimit(
      threadLimit === 100 ? 200 : threadLimit === 200 ? 500 : 1000,
    );
  };
  const currentLinked =
    selection?.kind === "thread" &&
    context?.links.some(
      (l) => l.conversationId === (thread?.canonical ?? selection.target),
    );
  return (
    <div ref={scroller} className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl space-y-3 p-3 md:p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-base font-semibold">Mattermost</h1>
            <p
              className="text-xs text-muted-foreground"
              title={result ? date(result.fetchedAt) : undefined}
            >
              {result
                ? (result.cache === "stale" ? "Saved " : "Updated ") +
                  age(result.fetchedAt)
                : "Work context for BB"}
              {pending || result?.refreshing ? " · Checking for updates…" : ""}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={refresh}
          >
            Refresh
          </Button>
        </div>
        <div className="flex flex-wrap gap-1" aria-label="Mattermost views">
          {(
            [
              ...(threadId ? ["context" as View] : []),
              "mentions",
              "unread",
              "channels",
              "search",
            ] as View[]
          ).map((tab) => (
            <Button
              key={tab}
              size="sm"
              variant={view === tab && !selection ? "secondary" : "ghost"}
              aria-pressed={view === tab && !selection}
              onClick={() => choose(tab)}
            >
              {
                {
                  context: "This thread",
                  mentions: "Mentions",
                  unread: "Unread",
                  channels: "Channels & DMs",
                  search: "Search",
                }[tab]
              }
              {tab === "context" && context?.links.length
                ? " · " + context.links.length
                : ""}
            </Button>
          ))}
        </div>
        {view === "context" && !selection ? (
          <section className="space-y-2 rounded-lg border border-border bg-card p-3">
            <h2 className="text-sm font-medium">
              {context?.title ?? "This BB thread"}
            </h2>
            {context?.project || context?.branch ? (
              <p className="text-xs text-muted-foreground">
                {[context.project, context.branch].filter(Boolean).join(" · ")}
              </p>
            ) : null}
            {contextError ? (
              <p role="alert" className="text-xs text-destructive">
                {contextError}{" "}
                <button onClick={fetchContext} className="underline">
                  Retry
                </button>
              </p>
            ) : null}
            {context?.links.length ? (
              <ul className="space-y-1">
                {context.links.map((l) => (
                  <li
                    key={l.conversationId}
                    className="flex items-center justify-between gap-2"
                  >
                    <button
                      className="min-w-0 cursor-pointer break-words text-left text-sm underline decoration-border underline-offset-4"
                      onClick={() =>
                        open({
                          kind: "thread",
                          target: l.conversationId,
                          title: l.title,
                        })
                      }
                    >
                      {l.title}
                    </button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={linking}
                      aria-label={"Unlink " + l.title}
                      onClick={() => link(l.conversationId, l.title, true)}
                    >
                      Unlink
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">
                Link a conversation to keep it with this BB thread and make it
                available to the agent. Start from your mentions below, or
                search Mattermost.
              </p>
            )}
            {context?.suggestedQuery ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setQuery(context.suggestedQuery);
                  setSearch(context.suggestedQuery);
                  choose("search");
                }}
              >
                Search “{context.suggestedQuery}”
              </Button>
            ) : null}
          </section>
        ) : null}
        {selection ? (
          <div className="space-y-2">
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const frame = trail.at(-1);
                  setSelection(frame?.selection ?? null);
                  setThreadLimit(frame?.limit ?? 100);
                  setTrail((t) => t.slice(0, -1));
                  setFilter(frame?.filter ?? "");
                  restoreScroll.current = frame?.scrollTop ?? 0;
                }}
              >
                ← Back
              </Button>
              <h2 className="min-w-0 break-words text-sm font-medium">
                {selection.title}
              </h2>
            </div>
            <div className="flex flex-wrap gap-1">
              {threadId && selection.kind === "thread" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={linking}
                  onClick={() =>
                    link(
                      thread?.canonical ?? selection.target,
                      selection.title,
                      !!currentLinked,
                    )
                  }
                >
                  {currentLinked
                    ? "Unlink conversation"
                    : "Link to this thread"}
                </Button>
              ) : null}
              {selection.kind === "thread" && posts[0]?.channel_id ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    open({
                      kind: "messages",
                      target: posts[0].channel_id!,
                      title: posts[0].channel ?? "Channel",
                    })
                  }
                >
                  Open channel
                </Button>
              ) : null}
              {posts.length && threadId ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => addToDraft(posts, selection.title)}
                >
                  {selection.kind === "thread"
                    ? "Add conversation to draft"
                    : "Add loaded messages to draft"}
                </Button>
              ) : null}
              {posts.length ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => draftTask(posts, selection.title)}
                >
                  Draft BB task
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
        {selection?.kind === "messages" ? (
          <div className="flex items-center gap-2" aria-label="Channel layout">
            <Button
              size="sm"
              variant={channelMode === "threads" ? "secondary" : "ghost"}
              aria-pressed={channelMode === "threads"}
              onClick={() => setChannelMode("threads")}
            >
              Conversations
            </Button>
            <Button
              size="sm"
              variant={channelMode === "messages" ? "secondary" : "ghost"}
              aria-pressed={channelMode === "messages"}
              onClick={() => setChannelMode("messages")}
            >
              All messages
            </Button>
          </div>
        ) : null}
        {thread && result ? (
          <section
            className="space-y-2 rounded-md bg-muted p-3 text-xs"
            aria-label="Conversation summary"
          >
            {selection?.focusPostId &&
            !posts.some((p) => p.id === selection.focusPostId) &&
            !pending ? (
              <p>
                The message you opened is outside the loaded replies. Load
                earlier replies to find it.
              </p>
            ) : null}
            <p>
              {thread.replies.length}{" "}
              {thread.replies.length === 1 ? "reply" : "replies"} loaded ·{" "}
              {new Set(posts.map((p) => p.author)).size} participants
            </p>
            {thread.missing !== null && thread.missing > 0 ? (
              <p>
                {thread.missing} earlier replies are outside this view. The
                original message and most recent replies are shown.
              </p>
            ) : threadLimit === posts.length ? (
              <p>This view may omit earlier replies.</p>
            ) : null}
            {(thread.missing === null
              ? posts.length >= threadLimit
              : thread.missing > 0) && threadLimit < 1000 ? (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={moreReplies}
              >
                Load earlier replies
              </Button>
            ) : null}
            {threadLimit === 1000 &&
            ((thread.missing ?? 0) > 0 || posts.length >= 1000) ? (
              <p>
                Showing up to 1,000 messages. Open the original conversation in
                Mattermost for older replies.
              </p>
            ) : null}
          </section>
        ) : null}
        {view === "search" && !selection ? (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (query.trim().length >= 2) {
                setSearch(query.trim());
                setFilter("");
              }
            }}
          >
            <div className="flex gap-2">
              <Input
                aria-label="Search Mattermost"
                placeholder="Search all messages…"
                maxLength={300}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <Button
                size="sm"
                type="submit"
                disabled={
                  query.trim().length < 2 || query.trim().startsWith("-")
                }
              >
                Search
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Use from:person, in:channel or after:2026-10-01 to narrow results.
            </p>
          </form>
        ) : null}
        {view !== "search" || selection || result ? (
          <div className="flex flex-wrap gap-2">
            <Input
              className="min-w-32 flex-1"
              aria-label="Filter loaded results"
              placeholder={
                channels.length
                  ? "Find a channel or DM…"
                  : "Filter loaded results…"
              }
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            {!selection && view === "channels" ? (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                Sort
                <select
                  aria-label="Sort channels and DMs"
                  value={channelSort}
                  onChange={(e) =>
                    setChannelSort(e.target.value as ChannelSort)
                  }
                  className="h-9 rounded-md border border-input bg-background px-2 text-xs text-foreground"
                >
                  {Object.entries(channelSortOptions).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {!selection && ["mentions", "context"].includes(view) ? (
              <select
                aria-label="Look back period"
                value={since}
                onChange={(e) => setSince(e.target.value as typeof since)}
                className="rounded-md border border-input bg-background px-2 text-xs"
              >
                <option value="6h">Past 6 hours</option>
                <option value="1d">Past day</option>
                <option value="7d">Past week</option>
              </select>
            ) : null}
          </div>
        ) : null}
        {notice ? (
          <p role="status" className="rounded-md bg-muted p-2 text-xs">
            {notice}
          </p>
        ) : null}
        {error || result?.refreshError ? (
          <div
            role="alert"
            className="rounded-md border border-border p-3 text-xs"
          >
            {error ?? result?.refreshError}
            <Button size="sm" variant="ghost" onClick={refresh}>
              Try again
            </Button>
          </div>
        ) : null}
        {!result && pending ? (
          <p
            role="status"
            className="py-6 text-center text-sm text-muted-foreground"
          >
            Loading Mattermost for the first time…
          </p>
        ) : null}
        {visiblePosts.map((post, index) => {
          const conversationId = getConversationId(post);
          const group = groups.length
            ? matchingGroups.find((g) => g.id === conversationId)
            : undefined;
          const isRoot = thread?.root === post;
          const focused = selection?.focusPostId === post.id;
          const previous = visiblePosts[index - 1];
          const day = new Date(post.created_at).toLocaleDateString();
          const showDay =
            !!thread &&
            (!previous ||
              new Date(previous.created_at).toLocaleDateString() !== day);
          const title =
            (post.channel ?? "Conversation") +
            " · " +
            post.message.replace(/\s+/g, " ").slice(0, 65);
          const linked = context?.links.some(
            (l) => l.conversationId === conversationId,
          );
          return (
            <div key={post.id ?? index} className="space-y-2">
              {showDay ? (
                <p className="py-1 text-center text-xs text-muted-foreground">
                  {day}
                </p>
              ) : null}
              {thread && !thread.root && index === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Original message is unavailable in this saved view. Refresh to
                  retrieve it.
                </p>
              ) : null}
              {thread && index === (thread.root ? 1 : 0) ? (
                <h3 className="text-xs font-medium text-muted-foreground">
                  Replies
                </h3>
              ) : null}
              <article
                data-post-id={post.id}
                aria-label={
                  thread
                    ? isRoot
                      ? "Original message"
                      : focused
                        ? "Selected reply"
                        : "Reply"
                    : undefined
                }
                className={
                  "space-y-2 rounded-lg border border-border bg-card p-3" +
                  (thread && !isRoot ? " ml-3 border-l-2" : "") +
                  (focused ? " ring-2 ring-ring" : "")
                }
              >
                {isRoot ? (
                  <p className="text-xs font-semibold">Original message</p>
                ) : focused ? (
                  <p className="text-xs font-semibold">
                    Opened from this message
                  </p>
                ) : null}
                {group && !group.root ? (
                  <p className="text-xs text-muted-foreground">
                    Reply preview · open to read the original message
                  </p>
                ) : null}
                {!thread && post.is_reply && post.root ? (
                  <blockquote className="border-l-2 border-border pl-2 text-xs text-muted-foreground">
                    In reply to {post.root.author}: {post.root.message}
                  </blockquote>
                ) : null}
                <div className="flex flex-wrap items-center justify-between gap-1 text-xs">
                  <span className="font-medium">
                    {post.author}
                    {post.channel ? " · " + post.channel : ""}
                    {linked ? " · Linked" : ""}
                  </span>
                  <time
                    title={date(post.created_at)}
                    dateTime={post.created_at}
                    className="text-muted-foreground"
                  >
                    {age(post.created_at)}
                  </time>
                </div>
                <div className="break-words text-sm [overflow-wrap:anywhere]">
                  <Markdown
                    content={post.message || "(Attachment or system message)"}
                  />
                </div>
                {group ? (
                  <div className="space-y-1 border-t border-border pt-2 text-xs text-muted-foreground">
                    <p>
                      {group.replyCount} {!group.root ? "loaded " : ""}
                      {group.replyCount === 1 ? "reply" : "replies"} ·{" "}
                      {group.participants.join(", ")}
                    </p>
                    {group.latest !== post ? (
                      <blockquote className="border-l-2 border-border pl-2">
                        Latest · {group.latest.author}:{" "}
                        {group.latest.message.slice(0, 220)}
                      </blockquote>
                    ) : null}
                  </div>
                ) : null}
                {post.file_count ? (
                  <p className="text-xs text-muted-foreground">
                    Attachments:{" "}
                    {post.files?.map((f) => f.name).join(", ") ??
                      post.file_count}
                  </p>
                ) : null}
                <div className="flex flex-wrap items-center gap-1">
                  {serverUrl && post.id ? (
                    <UrlLink
                      className="px-2 text-xs underline"
                      href={serverUrl + "/_redirect/pl/" + post.id}
                    >
                      Open in Mattermost
                    </UrlLink>
                  ) : null}
                  {selection?.kind !== "thread" && conversationId ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        open({
                          kind: "thread",
                          target: conversationId,
                          focusPostId: group ? undefined : post.id,
                          title:
                            "Conversation · " + (post.channel ?? post.author),
                        })
                      }
                    >
                      Read conversation
                    </Button>
                  ) : null}
                  {threadId ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => addToDraft([post], title)}
                    >
                      Quote in BB
                    </Button>
                  ) : null}
                  {threadId &&
                  conversationId &&
                  selection?.kind !== "thread" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={linking || linked}
                      onClick={() => link(conversationId, title)}
                    >
                      {linked ? "Linked" : "Link"}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => draftTask([post], title)}
                  >
                    Draft BB task
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      void experimental_copyToClipboard({
                        text: quotePosts([post], title),
                      }).then((ok) =>
                        setNotice(
                          ok
                            ? "Copied message and source ID."
                            : "Could not copy. Try Quote in BB.",
                        ),
                      );
                    }}
                  >
                    Copy
                  </Button>
                </div>
              </article>
            </div>
          );
        })}
        {visibleChannels.length ? (
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {visibleChannels.map((c, index) => (
              <li key={c.id ?? c.channel_id ?? c.ref ?? index}>
                <button
                  type="button"
                  className="flex w-full cursor-pointer flex-wrap items-start justify-between gap-2 p-3 text-left hover:bg-accent"
                  disabled={!(c.id ?? c.channel_id)}
                  onClick={() =>
                    (c.id ?? c.channel_id) &&
                    open({
                      kind: "messages",
                      target: (c.id ?? c.channel_id)!,
                      title: c.name ?? c.channel ?? "Channel",
                    })
                  }
                >
                  <span className="min-w-0 break-words text-sm font-medium">
                    {c.name ?? c.channel}
                    {c.unread ? " · " + c.unread + " unread" : ""}
                    <span className="mt-1 block text-xs font-normal text-muted-foreground">
                      {[c.type, c.team].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  {c.last_post_at ? (
                    <time
                      title={date(c.last_post_at)}
                      className="text-xs text-muted-foreground"
                    >
                      {age(c.last_post_at)}
                    </time>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {thread &&
        filter &&
        thread.root &&
        visiblePosts.length === 1 &&
        visiblePosts[0] === thread.root ? (
          <p role="status" className="text-xs text-muted-foreground">
            No replies match this filter. The original message stays visible for
            context.
          </p>
        ) : null}
        {result && !visiblePosts.length && !visibleChannels.length ? (
          <p
            role="status"
            className="rounded-lg border border-dashed border-border p-5 text-center text-sm text-muted-foreground"
          >
            {filter
              ? "No matching results."
              : view === "unread" && !selection
                ? "You're caught up. No unread channels."
                : "No messages found. Try a wider period or another search."}
          </p>
        ) : null}
        {result ? (
          <p className="text-xs text-muted-foreground">
            {channels.length
              ? channels.length + " channels"
              : groups.length
                ? matchingGroups.length + " conversations"
                : posts.length + " messages"}{" "}
            ·{" "}
            {result.cache === "stale"
              ? "Saved copy"
              : "Cached for quick reopening"}{" "}
            ·{" "}
            {view === "search"
              ? "Up to 50 search results"
              : selection?.kind === "thread"
                ? "Up to " + threadLimit + " messages"
                : "From the latest 100 channel messages"}
          </p>
        ) : null}
      </div>
    </div>
  );
}
function Inbox() {
  return <MattermostPage />;
}
function ThreadMattermost({ threadId }: { threadId: string }) {
  return <MattermostPage key={threadId} threadId={threadId} />;
}
export default definePluginApp((app) => {
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "fixed",
    id: "mattermost",
    title: "Mattermost",
    icon: "MessageSquare",
    component: ThreadMattermost,
    layout: "flush",
  });
  app.slots.navPanel({
    id: "inbox",
    title: "Mattermost",
    icon: "MessageSquare",
    path: "inbox",
    component: Inbox,
  });
});
