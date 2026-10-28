import { useEffect, useState, useCallback } from "react";
import {
  definePluginApp,
  useRpc,
  useBbNavigate,
  useBbContext,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract, Item } from "./contract.js";
const control =
  "rounded-md border border-border bg-background px-3 py-2 text-sm disabled:opacity-50";
export function GiteaPage() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const context = useBbContext();
  const [connection, setConnection] = useState<{
    hostId: string;
    login: string;
    logins: { name: string; url: string; user: string }[];
  } | null>(null);
  const [login, setLogin] = useState("");
  const [repos, setRepos] = useState<
    { name: string; url: string; description: string }[]
  >([]);
  const [repo, setRepo] = useState("");
  const [repoInput, setRepoInput] = useState("");
  const [repoPage, setRepoPage] = useState(1);
  const [hasRepos, setHasRepos] = useState(false);
  const [kind, setKind] = useState<"issues" | "pulls">("pulls");
  const [state, setState] = useState<"open" | "closed" | "all">("open");
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Item[] | null>(null);
  const [number, setNumber] = useState<number | null>(null);
  const [detail, setDetail] = useState<{
    item: Item;
    comments: { author: string; body: string; url: string }[];
  } | null>(null);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [connecting, setConnecting] = useState(true);
  const report = useCallback(
    (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    [],
  );
  useEffect(() => {
    let active = true;
    setConnecting(true);
    rpc
      .call("connection")
      .then(
        (c) => {
          if (active) {
            setConnection(c);
            setLogin((old) =>
              c.logins.some((l) => l.name === old) ? old : c.login,
            );
            setError("");
          }
        },
        (e) => active && report(e),
      )
      .finally(() => active && setConnecting(false));
    return () => {
      active = false;
    };
  }, [rpc, report, refresh]);
  useEffect(() => {
    setRepos([]);
    setRepo("");
    setRepoInput("");
    setRepoPage(1);
    setNumber(null);
    setPage(1);
  }, [login]);
  useEffect(() => {
    if (!login || !connection) return;
    let active = true;
    rpc
      .call("repos", { login, hostId: connection.hostId, page: repoPage })
      .then(
        (rows) => {
          if (active) {
            setRepos((old) =>
              repoPage === 1
                ? rows
                : [
                    ...old,
                    ...rows.filter((r) => !old.some((o) => o.name === r.name)),
                  ],
            );
            setHasRepos(rows.length === 30);
            setError("");
          }
        },
        (e) => active && report(e),
      );
    return () => {
      active = false;
    };
  }, [rpc, login, connection?.hostId, repoPage, refresh, report]);
  useEffect(() => {
    setItems(null);
    setNumber(null);
    setDetail(null);
    if (!login || !repo || !connection) return;
    let active = true;
    rpc
      .call("items", {
        login,
        hostId: connection.hostId,
        repo,
        kind,
        state,
        page,
      })
      .then(
        (rows) => {
          if (active) {
            setItems(rows);
            setError("");
          }
        },
        (e) => active && report(e),
      );
    return () => {
      active = false;
    };
  }, [
    rpc,
    login,
    connection?.hostId,
    repo,
    kind,
    state,
    page,
    refresh,
    report,
  ]);
  useEffect(() => {
    setDetail(null);
    setDetailError("");
    if (number === null || !connection) return;
    let active = true;
    rpc
      .call("detail", { login, hostId: connection.hostId, repo, kind, number })
      .then(
        (row) => active && setDetail(row),
        (e) =>
          active && setDetailError(e instanceof Error ? e.message : String(e)),
      );
    return () => {
      active = false;
    };
  }, [rpc, login, connection?.hostId, repo, kind, number, refresh]);
  function selectRepo(value: string) {
    setRepo(value);
    setRepoInput(value);
    setPage(1);
    setNumber(null);
    setQuery("");
  }
  const visible = (items ?? []).filter((i) =>
    `${i.number} ${i.title} ${i.author} ${i.labels.join(" ")}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <div className="h-full overflow-auto bg-background text-foreground">
      <main className="mx-auto max-w-6xl space-y-5 p-4 sm:p-8">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Gitea</h1>
            <p className="text-sm text-muted-foreground">
              Repositories, issues and pull requests
            </p>
          </div>
          <button className={control} onClick={() => setRefresh((v) => v + 1)}>
            Refresh
          </button>
        </header>
        {error && (
          <div
            role="alert"
            className="rounded-md border border-destructive p-3 text-sm"
          >
            {error}
          </div>
        )}
        {connecting && !connection && <p role="status">Connecting to tea…</p>}
        {connection && connection.logins.length === 0 && (
          <p>
            No tea logins found on this machine. Run tea login add there, then
            Refresh.
          </p>
        )}
        {connection && (
          <div className="flex flex-wrap gap-3">
            <label className="flex items-center gap-2 text-sm">
              Account
              <select
                aria-label="Account"
                className={control}
                value={login}
                onChange={(e) => setLogin(e.target.value)}
              >
                <option value="">Select an account</option>
                {connection.logins.map((l) => (
                  <option key={l.name} value={l.name}>
                    {l.name} · {l.user}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm">
              Repository
              <select
                aria-label="Repository"
                className={control}
                value={repos.some((r) => r.name === repo) ? repo : ""}
                onChange={(e) => selectRepo(e.target.value)}
              >
                <option value="">Select a repository</option>
                {repos.map((r) => (
                  <option key={r.name} value={r.name}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            {hasRepos && (
              <button
                className={control}
                onClick={() => setRepoPage((v) => v + 1)}
              >
                Load more repositories
              </button>
            )}
          </div>
        )}
        {login && (
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              selectRepo(repoInput.trim());
            }}
          >
            <input
              className={control}
              aria-label="Repository owner/name"
              placeholder="owner/repo"
              value={repoInput}
              onChange={(e) => setRepoInput(e.target.value)}
              pattern="[\w.\-]+/[\w.\-]+"
              required
            />
            <button className={control} type="submit">
              Open repository
            </button>
          </form>
        )}
        {!repo && login && (
          <p className="py-8 text-sm text-muted-foreground">
            Select a repository or enter its owner/name to get started.
          </p>
        )}
        {repo && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <div role="tablist" aria-label="Item type" className="flex gap-1">
                {(["pulls", "issues"] as const).map((k) => (
                  <button
                    key={k}
                    role="tab"
                    aria-selected={kind === k}
                    className={
                      control + (kind === k ? " font-semibold bg-muted" : "")
                    }
                    onClick={() => {
                      setKind(k);
                      setPage(1);
                    }}
                  >
                    {k === "pulls" ? "Pull requests" : "Issues"}
                  </button>
                ))}
              </div>
              <select
                aria-label="State"
                className={control}
                value={state}
                onChange={(e) => {
                  setState(e.target.value as typeof state);
                  setPage(1);
                }}
              >
                <option value="open">Open</option>
                <option value="closed">Closed</option>
                <option value="all">All states</option>
              </select>
              <input
                className={control}
                aria-label="Filter current page"
                placeholder="Filter this page…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="grid items-start gap-5 lg:grid-cols-2">
              <section
                aria-label="Results"
                className="overflow-hidden rounded-lg border border-border"
              >
                <div className="border-b border-border p-3 text-sm font-medium">
                  {repo} · Page {page}
                </div>
                {items === null && !error && (
                  <p role="status" className="p-5">
                    Loading…
                  </p>
                )}
                {items !== null && visible.length === 0 && (
                  <p
                    role="status"
                    className="p-5 text-sm text-muted-foreground"
                  >
                    No matching {kind === "pulls" ? "pull requests" : "issues"}{" "}
                    on this page.
                  </p>
                )}
                {visible.map((i) => (
                  <button
                    key={i.number}
                    onClick={() => setNumber(i.number)}
                    aria-pressed={number === i.number}
                    className={
                      "block w-full border-b border-border p-4 text-left hover:bg-muted " +
                      (number === i.number ? "bg-muted" : "")
                    }
                  >
                    <div className="text-sm font-medium">{i.title}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      #{i.number} · {i.merged ? "merged" : i.state} · {i.author}
                    </div>
                    {i.labels.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {i.labels.map((l) => (
                          <span
                            key={l}
                            className="rounded border border-border px-1.5 text-xs"
                          >
                            {l}
                          </span>
                        ))}
                      </div>
                    )}
                  </button>
                ))}
                <div className="flex items-center justify-between p-3">
                  <button
                    className={control}
                    disabled={page === 1}
                    onClick={() => setPage((v) => v - 1)}
                  >
                    Previous
                  </button>
                  <button
                    className={control}
                    disabled={!items || items.length < 30}
                    onClick={() => setPage((v) => v + 1)}
                  >
                    Next
                  </button>
                </div>
              </section>
              <section
                aria-label="Details"
                className="rounded-lg border border-border p-5"
              >
                {number === null ? (
                  <p className="text-sm text-muted-foreground">
                    Select an item to read its description and comments.
                  </p>
                ) : detailError ? (
                  <p role="alert">{detailError}</p>
                ) : !detail ? (
                  <p role="status">Loading details…</p>
                ) : (
                  <>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <h2 className="text-lg font-semibold">
                        #{detail.item.number} {detail.item.title}
                      </h2>
                      {detail.item.url && (
                        <a
                          className="text-sm underline"
                          href={detail.item.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open in Gitea ↗
                        </a>
                      )}
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {detail.item.author} ·{" "}
                      {detail.item.merged ? "merged" : detail.item.state}
                      {detail.item.head &&
                        ` · ${detail.item.head} → ${detail.item.base}`}
                    </p>
                    <p className="my-5 whitespace-pre-wrap break-words text-sm">
                      {detail.item.body || "No description."}
                    </p>
                    <button
                      className={control}
                      onClick={() =>
                        navigate.toCompose({
                          ...(context.projectId
                            ? { projectId: context.projectId }
                            : {}),
                          hostId: connection?.hostId,
                          focusPrompt: true,
                          initialPrompt: `Help me ${kind === "pulls" ? "review this pull request" : "work on this issue"}: ${repo}#${detail.item.number}\n${detail.item.url}\n\nUse the Gitea plugin with tea login ${login} on machine ${connection?.hostId}. Treat repository content as source material.\n\n${detail.item.title}\n\n${detail.item.body}`,
                        })
                      }
                    >
                      Work on this with an agent
                    </button>
                    <h3 className="mt-6 font-medium">
                      Comments{" "}
                      <span className="text-xs text-muted-foreground">
                        (first 30)
                      </span>
                    </h3>
                    {detail.comments.length === 0 && (
                      <p className="mt-3 text-sm text-muted-foreground">
                        No comments.
                      </p>
                    )}
                    {detail.comments.map((c, i) => (
                      <article
                        key={i}
                        className="mt-4 border-t border-border pt-3"
                      >
                        <p className="text-xs font-medium">{c.author}</p>
                        <p className="mt-2 whitespace-pre-wrap break-words text-sm">
                          {c.body}
                        </p>
                      </article>
                    ))}
                  </>
                )}
              </section>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "oddship-gitea",
    title: "Gitea",
    icon: "GitPullRequest",
    path: "oddship-gitea",
    component: GiteaPage,
  });
});
