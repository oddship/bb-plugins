import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  definePluginApp,
  Markdown,
  useRpc,
  useRealtime,
  useBbNavigate,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { Item, Tracked, Selection } from "./model";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Icon } from "./components/ui/icon";

type Detail = {
  item: Item;
  notes: {
    id: number;
    author: string;
    body: string;
    createdAt: string;
    system: boolean;
  }[];
};
const selectClass =
  "h-9 max-w-full rounded-md border border-input bg-background px-2 text-sm";
const textareaClass =
  "min-h-28 w-full rounded-md border border-input bg-background p-3 text-sm";
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
function route(s: Selection) {
  return [s.kind, s.repo, s.number].join("/");
}
export function parseRoute(subPath: string): Selection | null {
  if (!subPath) return null;
  try {
    const [kind, ...parts] = subPath.split("/");
    const number = parts.pop() ?? "";
    const repo = parts.map(decodeURIComponent).join("/");
    if (!["issue", "mr"].includes(kind) || !/^\d+$/.test(number) ||
        !Number.isSafeInteger(Number(number)) || Number(number) < 1 ||
        repo.split("/").length < 3) return null;
    return { kind: kind as "issue" | "mr", repo, number: Number(number) };
  } catch {
    return null;
  }
}

function GitlabPage({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>(),
    navigate = useBbNavigate();
  const [repos, setRepos] = useState<Tracked[]>([]),
    [repo, setRepo] = useState(""),
    [kind, setKind] = useState<"issue" | "mr">("issue"),
    [state, setState] = useState<"opened" | "closed" | "merged" | "all">(
      "opened",
    ),
    [query, setQuery] = useState(""),
    [page, setPage] = useState(1);
  const [items, setItems] = useState<Item[]>([]),
    [total, setTotal] = useState(0),
    [hasMore, setHasMore] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [syncErrors, setSyncErrors] = useState<string[]>([]),
    [syncedAt, setSyncedAt] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [account, setAccount] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null),
    [detailError, setDetailError] = useState(""),
    [comment, setComment] = useState(""),
    [creating, setCreating] = useState(false),
    [title, setTitle] = useState(""),
    [body, setBody] = useState("");
  const [users, setUsers] = useState<
      { id: number; username: string; name: string }[]
    >([]),
    [usersLoaded, setUsersLoaded] = useState(false),
    [assigneeIds, setAssigneeIds] = useState<number[]>([]),
    [reviewerIds, setReviewerIds] = useState<number[]>([]);
  const request = useRef(0),
    detailRequest = useRef(0);
  const selection = parseRoute(subPath);
  const refresh = useCallback(async () => {
    const id = ++request.current;
    try {
      const [r, l] = await Promise.all([
        rpc.call("repos"),
        rpc.call("list", {
          ...(repo ? { repo } : {}),
          kind,
          state,
          query,
          page,
        }),
      ]);
      if (id !== request.current) return;
      setRepos(r.repos);
      setItems(l.items);
      setTotal(l.total);
      setHasMore(l.hasMore);
      setSyncedAt(l.syncedAt);
      setSyncErrors(l.errors);
      setError("");
    } catch (e) {
      if (id === request.current) setError(message(e));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [rpc, repo, kind, state, query, page]);
  useEffect(() => {
    setLoading(true);
    void refresh();
    return () => {
      request.current++;
    };
  }, [refresh]);
  useRealtime("data-changed", () => {
    void refresh();
  });
  useEffect(() => {
    let active = true;
    rpc.call("status").then(
      (s) => {
        if (active)
          setAccount(
            s.error ? `${s.host}: ${s.error}` : `${s.username} on ${s.host}`,
          );
      },
      (e) => {
        if (active) setAccount(message(e));
      },
    );
    return () => {
      active = false;
    };
  }, [rpc]);
  const loadDetail = useCallback(async () => {
    const s = parseRoute(subPath);
    if (!s) {
      setDetail(null);
      return;
    }
    const id = ++detailRequest.current;
    setDetailError("");
    try {
      const d = await rpc.call("detail", s);
      if (id === detailRequest.current) setDetail(d);
    } catch (e) {
      if (id === detailRequest.current) setDetailError(message(e));
    }
  }, [rpc, subPath]);
  useEffect(() => {
    setDetail(null);
    setComment("");
    setUsers([]);
    setUsersLoaded(false);
    void loadDetail();
    return () => {
      detailRequest.current++;
    };
  }, [loadDetail]);
  const act = async (fn: () => Promise<void>, report = setError) => {
    if (busy) return;
    setBusy(true);
    report("");
    try {
      await fn();
    } catch (e) {
      report(message(e));
    } finally {
      setBusy(false);
    }
  };
  const open = (item: Item) =>
    navigate.toPluginPanel("browse", { subPath: route(item) });
  const reset = () => {
    setPage(1);
  };
  const sync = () =>
    act(async () => {
      const result = await rpc.call("sync");
      setSyncErrors(result.errors);
      await refresh();
    });
  const create = async (e: FormEvent) => {
    e.preventDefault();
    await act(async () => {
      const item = await rpc.call("createIssue", { repo, title, body });
      setCreating(false);
      setTitle("");
      setBody("");
      open(item);
      await refresh();
    });
  };
  const post = async (e: FormEvent) => {
    e.preventDefault();
    if (!selection) return;
    await act(async () => {
      await rpc.call("comment", { ...selection, body: comment });
      setComment("");
      await loadDetail();
    }, setDetailError);
  };
  const update = async (change: {
    state?: "close" | "reopen";
    assigneeIds?: number[];
    reviewerIds?: number[];
  }) => {
    if (!selection) return;
    await act(async () => {
      await rpc.call("update", { ...selection, ...change });
      setUsersLoaded(false);
      await loadDetail();
      await refresh();
    }, setDetailError);
  };
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <main className="mx-auto w-full max-w-5xl space-y-4 p-4 md:p-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">GitLab</h1>
            <p className="mt-1 break-words text-xs text-muted-foreground">
              {account || "Checking connection…"}
            </p>
          </div>
          <Button onClick={sync} disabled={busy}>
            <Icon name="RefreshCw" className="size-4" />
            {busy ? "Working…" : "Sync now"}
          </Button>
        </header>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {syncErrors.length > 0 && (
          <div
            role="alert"
            className="rounded-md border border-destructive p-3 text-sm"
          >
            <p>
              Some repositories could not sync. Their previous cache is
              retained.
            </p>
            {syncErrors.map((e) => (
              <p className="mt-1 break-words" key={e}>
                {e}
              </p>
            ))}
          </div>
        )}
        {subPath ? (
          <section className="space-y-4">
            <Button
              variant="ghost"
              onClick={() => navigate.toPluginPanel("browse")}
            >
              ← All items
            </Button>
            {!selection ? (
              <p role="alert">Invalid GitLab item link.</p>
            ) : (
              <>
                {detailError && (
                  <p role="alert" className="text-sm text-destructive">
                    {detailError}
                  </p>
                )}
                {!detail && !detailError && <p role="status">Loading item…</p>}
                {detail && (
                  <>
                    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
                      <p className="break-all text-xs text-muted-foreground">
                        {detail.item.repo} ·{" "}
                        {detail.item.kind === "mr" ? "Merge request" : "Issue"}{" "}
                        {detail.item.kind === "mr" ? "!" : "#"}
                        {detail.item.number}
                      </p>
                      <h2 className="text-lg font-semibold">
                        {detail.item.title}
                      </h2>
                      <p className="text-sm text-muted-foreground">
                        {detail.item.draft ? "Draft · " : ""}
                        {detail.item.state} · @{detail.item.author} ·{" "}
                        {detail.item.labels.join(", ")}
                      </p>
                      {detail.item.kind === "mr" && (
                        <p className="break-words text-sm">
                          {detail.item.sourceBranch} →{" "}
                          {detail.item.targetBranch}
                          {detail.item.pipeline
                            ? ` · Pipeline: ${detail.item.pipeline}`
                            : ""}
                        </p>
                      )}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          onClick={() => navigate.openUrl(detail.item.url)}
                        >
                          Open in GitLab
                        </Button>
                        <Button
                          disabled={busy}
                          onClick={() =>
                            act(async () => {
                              const t = await rpc.call("startWork", selection!);
                              navigate.toThread(t.threadId);
                            }, setDetailError)
                          }
                        >
                          {detail.item.kind === "mr"
                            ? "Start review"
                            : "Start work"}
                        </Button>
                        {detail.item.state !== "merged" && (
                          <Button
                            variant="outline"
                            disabled={busy}
                            onClick={() =>
                              update({
                                state:
                                  detail.item.state === "closed"
                                    ? "reopen"
                                    : "close",
                              })
                            }
                          >
                            {detail.item.state === "closed"
                              ? "Reopen"
                              : "Close"}{" "}
                            {detail.item.kind === "mr"
                              ? "merge request"
                              : "issue"}
                          </Button>
                        )}
                      </div>
                      <Markdown
                        content={detail.item.body || "No description."}
                      />
                    </div>
                    <section className="space-y-3 rounded-lg border border-border p-4">
                      <h3 className="font-medium">People</h3>
                      <p className="text-sm">
                        Assignees:{" "}
                        {detail.item.assignees.join(", ") || "Unassigned"}
                      </p>
                      {detail.item.kind === "mr" && (
                        <p className="text-sm">
                          Reviewers:{" "}
                          {detail.item.reviewers.join(", ") || "None"}
                        </p>
                      )}
                      {!usersLoaded ? (
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            act(async () => {
                              const u = await rpc.call("users", {
                                repo: detail.item.repo,
                              });
                              setUsers(u);
                              setAssigneeIds(
                                u
                                  .filter((x) =>
                                    detail.item.assignees.includes(x.username),
                                  )
                                  .map((x) => x.id),
                              );
                              setReviewerIds(
                                u
                                  .filter((x) =>
                                    detail.item.reviewers.includes(x.username),
                                  )
                                  .map((x) => x.id),
                              );
                              setUsersLoaded(true);
                            }, setDetailError)
                          }
                        >
                          Edit people
                        </Button>
                      ) : (
                        <>
                          <p className="text-xs text-muted-foreground">
                            Showing up to 100 project members. Selecting none
                            clears the assignment.
                          </p>
                          <label className="block text-sm">
                            Assignees
                            <select
                              multiple
                              aria-label="Assignees"
                              className="mt-1 block w-full rounded-md border border-input bg-background p-2"
                              value={assigneeIds.map(String)}
                              onChange={(e) =>
                                setAssigneeIds(
                                  Array.from(
                                    e.currentTarget.selectedOptions,
                                  ).map((x) => Number(x.value)),
                                )
                              }
                            >
                              {users.map((u) => (
                                <option key={u.id} value={u.id}>
                                  {u.name} (@{u.username})
                                </option>
                              ))}
                            </select>
                          </label>
                          <Button
                            variant="outline"
                            disabled={busy}
                            onClick={() => update({ assigneeIds })}
                          >
                            Save assignees
                          </Button>
                          {detail.item.kind === "mr" && (
                            <>
                              <label className="block text-sm">
                                Reviewers
                                <select
                                  multiple
                                  aria-label="Reviewers"
                                  className="mt-1 block w-full rounded-md border border-input bg-background p-2"
                                  value={reviewerIds.map(String)}
                                  onChange={(e) =>
                                    setReviewerIds(
                                      Array.from(
                                        e.currentTarget.selectedOptions,
                                      ).map((x) => Number(x.value)),
                                    )
                                  }
                                >
                                  {users.map((u) => (
                                    <option key={u.id} value={u.id}>
                                      {u.name} (@{u.username})
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <Button
                                variant="outline"
                                disabled={busy}
                                onClick={() => update({ reviewerIds })}
                              >
                                Save reviewers
                              </Button>
                            </>
                          )}
                        </>
                      )}
                    </section>
                    <section className="space-y-3">
                      <h3 className="font-medium">Recent comments</h3>
                      {detail.notes.filter((n) => !n.system).length === 0 && (
                        <p className="text-sm text-muted-foreground">
                          No comments in the latest 100 notes.
                        </p>
                      )}
                      {detail.notes
                        .filter((n) => !n.system)
                        .slice()
                        .reverse()
                        .map((n) => (
                          <article
                            key={n.id}
                            className="rounded-lg border border-border p-3"
                          >
                            <p className="text-xs text-muted-foreground">
                              @{n.author} ·{" "}
                              {new Date(n.createdAt).toLocaleString()}
                            </p>
                            <Markdown className="mt-2" content={n.body} />
                          </article>
                        ))}
                      <form className="space-y-2" onSubmit={post}>
                        <label
                          className="block text-sm"
                          htmlFor="gitlab-comment"
                        >
                          Add a comment
                        </label>
                        <textarea
                          id="gitlab-comment"
                          className={textareaClass}
                          value={comment}
                          maxLength={20000}
                          onChange={(e) => setComment(e.target.value)}
                        />
                        <Button
                          disabled={busy || !comment.trim()}
                          type="submit"
                        >
                          Post comment
                        </Button>
                      </form>
                    </section>
                  </>
                )}
              </>
            )}
          </section>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <label className="sr-only" htmlFor="gitlab-repo">
                Repository
              </label>
              <select
                id="gitlab-repo"
                className={selectClass}
                value={repo}
                onChange={(e) => {
                  setRepo(e.target.value);
                  reset();
                }}
              >
                <option value="">All repositories</option>
                {repos.map((r) => (
                  <option key={r.repo} value={r.repo}>
                    {r.repo}
                  </option>
                ))}
              </select>
              <div className="flex gap-1" role="group" aria-label="Item type">
                {(["issue", "mr"] as const).map((k) => (
                  <Button
                    variant={kind === k ? "default" : "outline"}
                    key={k}
                    onClick={() => {
                      setKind(k);
                      if (k === "issue" && state === "merged")
                        setState("opened");
                      reset();
                    }}
                  >
                    {k === "mr" ? "Merge requests" : "Issues"}
                  </Button>
                ))}
              </div>
              <label className="sr-only" htmlFor="gitlab-state">
                State
              </label>
              <select
                id="gitlab-state"
                className={selectClass}
                value={state}
                onChange={(e) => {
                  setState(e.target.value as typeof state);
                  reset();
                }}
              >
                {[
                  "opened",
                  "closed",
                  ...(kind === "mr" ? ["merged"] : []),
                  "all",
                ].map((s) => (
                  <option key={s} value={s}>
                    {s === "opened" ? "Open" : s[0].toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </select>
              <Input
                className="w-full sm:w-60"
                aria-label="Search items"
                placeholder="Search title, label, or person"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  reset();
                }}
              />
              <Button
                variant="outline"
                disabled={!repo || busy}
                onClick={() => setCreating(!creating)}
              >
                New issue
              </Button>
            </div>
            {creating && (
              <form
                className="space-y-3 rounded-lg border border-border p-4"
                onSubmit={create}
              >
                <h2 className="font-medium">New issue in {repo}</h2>
                <Input
                  aria-label="Issue title"
                  required
                  maxLength={255}
                  placeholder="Title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
                <textarea
                  aria-label="Issue description"
                  className={textareaClass}
                  maxLength={50000}
                  placeholder="Description"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
                <div className="flex gap-2">
                  <Button
                    type="submit"
                    disabled={busy || !repo || !title.trim()}
                  >
                    Create issue
                  </Button>
                  <Button
                    variant="ghost"
                    type="button"
                    onClick={() => setCreating(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            )}
            {repos.length === 0 && !loading ? (
              <div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
                Add namespace/project entries under Settings → Plugins → GitLab
                → Extra repositories, or attach a BB project with a GitLab
                remote. Set the GitLab host for your instance and authenticate
                glab on the BB server.
              </div>
            ) : loading ? (
              <p role="status" className="text-sm">
                Loading items…
              </p>
            ) : items.length === 0 ? (
              <p
                role="status"
                className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground"
              >
                No matching items. Use Sync now to refresh the cache.
              </p>
            ) : (
              <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
                {items.map((i) => (
                  <li key={`${i.repo}/${i.kind}/${i.number}`}>
                    <button
                      className="w-full space-y-1 px-4 py-3 text-left hover:bg-muted/50"
                      onClick={() => open(i)}
                    >
                      <span className="block text-sm font-medium">
                        {i.draft && !/^(draft|wip):/i.test(i.title) ? "Draft: " : ""}
                        {i.title}
                      </span>
                      <span className="block break-all text-xs text-muted-foreground">
                        {i.repo} {i.kind === "mr" ? "!" : "#"}
                        {i.number} · {i.state} · @{i.author}
                        {i.labels.length ? ` · ${i.labels.join(", ")}` : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <footer className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <p>
                {total} cached matches ·{" "}
                {syncedAt
                  ? `Synced ${new Date(syncedAt).toLocaleString()}`
                  : "Not yet synced"}{" "}
                · Latest 100 items per state per repository
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  disabled={page === 1}
                  onClick={() => setPage(page - 1)}
                >
                  Previous
                </Button>
                <span>Page {page}</span>
                <Button
                  variant="ghost"
                  disabled={!hasMore}
                  onClick={() => setPage(page + 1)}
                >
                  Next
                </Button>
              </div>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}
export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "oddship-gitlab",
    title: "GitLab",
    icon: "GitPullRequest",
    path: "browse",
    component: GitlabPage,
  });
});
