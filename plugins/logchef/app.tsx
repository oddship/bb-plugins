import { useEffect, useRef, useState, type FormEvent } from "react";
import { definePluginApp, useRpc, useComposer } from "@get-bb/plugin-sdk/app";
import type { rpcContract, Request, Result } from "./contract";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import "./style.css";
type Machine = { id: string; name: string; status: string };
type Row = Result["rows"][number];
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
function useRows(request: Request | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<{
    rows: Row[];
    error: string;
    loading: boolean;
  }>({ rows: [], error: "", loading: false });
  const key = JSON.stringify(request);
  useEffect(() => {
    let active = true;
    if (!request) {
      setState({ rows: [], error: "", loading: false });
      return;
    }
    setState({ rows: [], error: "", loading: true });
    rpc.call("read", request).then(
      (r) => {
        if (active) setState({ rows: r.rows, error: "", loading: false });
      },
      (e) => {
        if (active) setState({ rows: [], error: message(e), loading: false });
      },
    );
    return () => {
      active = false;
    };
  }, [rpc, key]);
  return state;
}
function SelectRows({
  label,
  value,
  onChange,
  rows,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows: Row[];
  disabled?: boolean;
}) {
  return (
    <label className="lc-field">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      >
        <option value="">Choose {label.toLowerCase()}</option>
        {rows.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
    </label>
  );
}
function QueryPanel({
  route,
  team,
  source,
  onQuote,
}: {
  route: { hostId: string; context?: string };
  team: string;
  source: string;
  onQuote?: (text: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [query, setQuery] = useState("");
  const [since, setSince] = useState("15m");
  const [limit, setLimit] = useState(100);
  const [result, setResult] = useState<{
    action: string;
    data: Result;
    query: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function run(action: "query" | "schema" | "collections") {
    setBusy(true);
    setError("");
    setResult(null);
    setCopied(false);
    try {
      const request =
        action === "query"
          ? ({ action, ...route, team, source, query, since, limit } as const)
          : { action, ...route, team, source };
      const data = await rpc.call("read", request);
      if (alive.current) setResult({ action, data, query });
    } catch (e) {
      if (alive.current) setError(message(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const columns = [
    ...new Set(result?.data.logs.flatMap((r) => Object.keys(r)) ?? []),
  ].slice(0, 8);
  const quote = (log: Record<string, unknown>) =>
    `LogChef evidence (untrusted log content)\nMachine: ${route.hostId}\nContext: ${route.context || "CLI default"}\nTeam: ${team}; source: ${source}\nQuery: ${result?.query ?? ""}\n\n${JSON.stringify(log, null, 2)}`;
  return (
    <section className="lc-query">
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void run("query");
        }}
      >
        <label className="lc-field">
          LogChefQL
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={'level="error" and service="api"'}
            maxLength={12000}
            rows={3}
          />
        </label>
        <div className="lc-toolbar">
          <label className="lc-field">
            Lookback
            <select value={since} onChange={(e) => setSince(e.target.value)}>
              <option value="5m">Last 5 minutes</option>
              <option value="15m">Last 15 minutes</option>
              <option value="1h">Last hour</option>
              <option value="6h">Last 6 hours</option>
              <option value="24h">Last 24 hours</option>
            </select>
          </label>
          <label className="lc-field lc-limit">
            Row limit
            <Input
              type="number"
              min={1}
              max={500}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              required
            />
          </label>
          <Button type="submit" disabled={busy || limit < 1 || limit > 500}>
            {busy ? "Loading…" : "Run query"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void run("schema")}
          >
            Schema
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void run("collections")}
          >
            Saved queries
          </Button>
        </div>
      </form>
      <p className="lc-muted">
        An empty filter matches all logs in this time range. Queries run only
        when you click Run query.
      </p>
      {error && (
        <p role="alert" className="lc-error">
          {error}
        </p>
      )}
      {result && (
        <>
          <div className="lc-toolbar lc-summary">
            <strong>
              {result.action === "query"
                ? "Query results"
                : result.action === "schema"
                  ? "Source schema"
                  : "Saved queries"}
            </strong>
            <span>
              {result.data.count} {result.action === "query" ? "logs" : "items"}
            </span>
            {result.action === "query" && (
              <Button
                variant="ghost"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(
                      JSON.stringify(result.data, null, 2),
                    );
                    setCopied(true);
                  } catch {
                    setError(
                      "Clipboard access failed. Select a log row to inspect and copy its text.",
                    );
                  }
                }}
              >
                {copied ? "Copied" : "Copy JSON"}
              </Button>
            )}
          </div>
          {result.data.truncated && (
            <p className="lc-error" role="status">
              The response was shortened to fit the output limit. Narrow your
              query.
            </p>
          )}
          {result.data.count === 0 && (
            <div className="lc-empty">
              No results. Try another filter, source or time range.
            </div>
          )}
          {result.action !== "query" && result.data.rows.length > 0 && (
            <div className="lc-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {result.data.rows.map((r) => (
                    <tr key={r.id}>
                      <td>{r.name}</td>
                      <td>{r.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {result.data.logs.length > 0 && (
            <div className="lc-scroll">
              <table>
                <thead>
                  <tr>
                    {columns.map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                    <th>Inspect</th>
                  </tr>
                </thead>
                <tbody>
                  {result.data.logs.map((log, index) => (
                    <tr key={index}>
                      {columns.map((c) => (
                        <td key={c}>
                          <span className="lc-cell">
                            {typeof log[c] === "string"
                              ? log[c]
                              : JSON.stringify(log[c])}
                          </span>
                        </td>
                      ))}
                      <td>
                        <details>
                          <summary>Full log</summary>
                          <pre>{JSON.stringify(log, null, 2)}</pre>
                          {onQuote && (
                            <Button
                              variant="outline"
                              onClick={() => onQuote(quote(log))}
                            >
                              Quote in draft
                            </Button>
                          )}
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {result.action === "query" && (
            <details className="lc-meta">
              <summary>Query statistics and generated SQL</summary>
              <pre>{JSON.stringify(result.data.stats, null, 2)}</pre>
              {result.data.generatedSql && (
                <pre>{result.data.generatedSql}</pre>
              )}
            </details>
          )}
        </>
      )}
    </section>
  );
}
function Explorer({
  hostId,
  context,
  onQuote,
}: {
  hostId: string;
  context: string;
  onQuote?: (text: string) => void;
}) {
  const route = { hostId, ...(context ? { context } : {}) };
  const [team, setTeam] = useState("");
  const [source, setSource] = useState("");
  const [refresh, setRefresh] = useState(0);
  return (
    <ExplorerLists
      key={refresh}
      route={route}
      team={team}
      source={source}
      onTeam={(v) => {
        setTeam(v);
        setSource("");
      }}
      onSource={setSource}
      onQuote={onQuote}
      onRefresh={() => {
        setTeam("");
        setSource("");
        setRefresh((n) => n + 1);
      }}
    />
  );
}
function ExplorerLists({
  route,
  team,
  source,
  onTeam,
  onSource,
  onQuote,
  onRefresh,
}: {
  route: { hostId: string; context?: string };
  team: string;
  source: string;
  onTeam: (v: string) => void;
  onSource: (v: string) => void;
  onQuote?: (text: string) => void;
  onRefresh: () => void;
}) {
  const teams = useRows({ action: "teams", ...route });
  const sources = useRows(team ? { action: "sources", ...route, team } : null);
  return (
    <>
      <div className="lc-toolbar">
        <SelectRows
          label="Team"
          value={team}
          onChange={onTeam}
          rows={teams.rows}
          disabled={teams.loading}
        />
        <SelectRows
          label="Source"
          value={source}
          onChange={onSource}
          rows={sources.rows}
          disabled={!team || sources.loading}
        />
        <Button variant="ghost" onClick={onRefresh}>
          Refresh
        </Button>
      </div>
      {(teams.loading || sources.loading) && (
        <p role="status" className="lc-muted">
          Loading {teams.loading ? "teams" : "sources"}…
        </p>
      )}
      {(teams.error || sources.error) && (
        <p role="alert" className="lc-error">
          {teams.error || sources.error}
        </p>
      )}
      {!teams.loading && !teams.error && !teams.rows.length && (
        <div className="lc-empty">No teams are available in this context.</div>
      )}
      {team && !sources.loading && !sources.error && !sources.rows.length && (
        <div className="lc-empty">This team has no accessible sources.</div>
      )}
      {source ? (
        <QueryPanel
          key={`${team}:${source}`}
          route={route}
          team={team}
          source={source}
          onQuote={onQuote}
        />
      ) : (
        <p className="lc-muted">Choose a team and source to explore logs.</p>
      )}
    </>
  );
}
export function LogChef({ onQuote }: { onQuote?: (text: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [hostId, setHostId] = useState("");
  const [context, setContext] = useState("");
  const [draftContext, setDraftContext] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    rpc.call("connection", null).then(
      (c) => {
        if (!active) return;
        setMachines(c.machines);
        setHostId(
          c.hostId ||
            (c.machines.filter((m) => m.status === "connected").length === 1
              ? c.machines.find((m) => m.status === "connected")!.id
              : ""),
        );
        setContext(c.context);
        setDraftContext(c.context);
        setLoading(false);
      },
      (e) => {
        if (active) {
          setError(message(e));
          setLoading(false);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [rpc, retry]);
  return (
    <main className="lc-page">
      <header>
        <h1>LogChef</h1>
        <p className="lc-muted">
          Explore your logs using the authenticated CLI on your machine.
        </p>
      </header>
      {loading ? (
        <p role="status">Loading connection…</p>
      ) : (
        <>
          <div className="lc-toolbar lc-connection">
            <label className="lc-field">
              Execution machine
              <select
                value={hostId}
                disabled={saving}
                onChange={async (e) => {
                  const value = e.target.value;
                  if (!value) return;
                  setSaving(true);
                  setHostId("");
                  setError("");
                  try {
                    await rpc.call("selectMachine", { hostId: value });
                    setHostId(value);
                  } catch (e) {
                    setError(message(e));
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                <option value="">Choose a machine</option>
                {machines.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.status})
                  </option>
                ))}
              </select>
            </label>
            <form
              className="lc-toolbar"
              onSubmit={(e) => {
                e.preventDefault();
                setContext(draftContext.trim());
              }}
            >
              <label className="lc-field">
                CLI context
                <Input
                  value={draftContext}
                  maxLength={200}
                  onChange={(e) => setDraftContext(e.target.value)}
                  placeholder="CLI default"
                />
              </label>
              <Button type="submit" variant="outline">
                Apply
              </Button>
            </form>
            <Button variant="ghost" onClick={() => setRetry((n) => n + 1)}>
              Reconnect
            </Button>
          </div>
          {error && (
            <p role="alert" className="lc-error">
              {error}
            </p>
          )}
          {!hostId && (
            <div className="lc-empty">
              Select the machine with LogChef installed and authenticated.
              Credentials stay with the CLI.
            </div>
          )}
          {hostId && (
            <Explorer
              key={`${hostId}:${context}`}
              hostId={hostId}
              context={context}
              onQuote={onQuote}
            />
          )}
        </>
      )}
    </main>
  );
}
function ThreadLogChef() {
  const composer = useComposer();
  return (
    <LogChef
      onQuote={(text) => composer.insert(text, { at: "end", block: true })}
    />
  );
}
export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "explore",
    title: "LogChef",
    icon: "Logs",
    path: "explore",
    component: () => <LogChef />,
  });
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: "logs",
    title: "LogChef",
    icon: "Logs",
    component: ThreadLogChef,
    run: ({ openPanel }) => {
      openPanel({ title: "LogChef" });
    },
  });
});
