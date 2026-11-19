import { useEffect, useState } from "react";
import { definePluginApp, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, View } from "./contract";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import "./style.css";

type Machine = { id: string; name: string; status: string };
const memory = (bytes: number) =>
  bytes >= 1073741824
    ? `${(bytes / 1073741824).toFixed(2)} GiB`
    : `${(bytes / 1048576).toFixed(1)} MiB`;
function Spark({ values }: { values: number[] }) {
  if (values.length < 2)
    return <span className="top-muted">Collecting samples</span>;
  const max = Math.max(1, ...values);
  return (
    <svg
      className="top-spark"
      viewBox="0 0 240 36"
      role="img"
      aria-label="Recent usage trend"
    >
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        points={values
          .map(
            (v, i) =>
              `${(i * 240) / (values.length - 1)},${34 - (v / max) * 30}`,
          )
          .join(" ")}
      />
    </svg>
  );
}
function Monitor({ machine }: { machine: Machine }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState("");
  const [paused, setPaused] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("cpu");
  const [history, setHistory] = useState<
    { at: number; cpu: number; rss: number }[]
  >([]);
  useEffect(() => {
    if (paused) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    async function read() {
      if (!active || busy) return;
      clearTimeout(timer);
      if (document.hidden) {
        timer = setTimeout(read, 2000);
        return;
      }
      busy = true;
      try {
        const next = await rpc.call("snapshot", { hostId: machine.id });
        if (!active) return;
        setView(next);
        setError("");
        setHistory((old) =>
          old.at(-1)?.at === next.at
            ? old
            : [
                ...old,
                {
                  at: next.at,
                  cpu: next.threads.reduce((sum, row) => sum + row.cpu, 0),
                  rss: next.threads.reduce((sum, row) => sum + row.rss, 0),
                },
              ].slice(-60),
        );
      } catch (cause) {
        if (active)
          setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        busy = false;
        if (active) timer = setTimeout(read, 2000);
      }
    }
    const visible = () => {
      if (!document.hidden) void read();
    };
    void read();
    document.addEventListener("visibilitychange", visible);
    return () => {
      active = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [rpc, machine.id, paused, refresh]);
  const rows = (view?.threads ?? [])
    .filter((t) =>
      `${t.title} ${t.id} ${t.status}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "memory"
        ? b.rss - a.rss
        : sort === "processes"
          ? b.count - a.count
          : sort === "title"
            ? a.title.localeCompare(b.title)
            : b.cpu - a.cpu || b.rss - a.rss,
    );
  const totalCpu = view?.threads.reduce((sum, row) => sum + row.cpu, 0) ?? 0;
  const totalRss = view?.threads.reduce((sum, row) => sum + row.rss, 0) ?? 0;
  const warm = !view?.intervalMs;
  return (
    <>
      <div className="top-toolbar">
        <span className="top-live">
          {paused ? "Paused" : error ? "Read failed" : "Live · every 2s"}
        </span>
        <span className="top-muted">
          {view
            ? `Sampled ${new Date(view.at).toLocaleTimeString()}`
            : "Waiting for first sample"}
        </span>
        <Button variant="outline" onClick={() => setPaused(!paused)}>
          {paused ? "Resume" : "Pause"}
        </Button>
        <Button
          variant="outline"
          disabled={paused}
          onClick={() => setRefresh((r) => r + 1)}
        >
          Refresh
        </Button>
      </div>
      {error && (
        <div className="top-error" role="alert">
          {error}
          {view ? " Showing the last successful sample." : ""}
        </div>
      )}
      <div className="top-metrics">
        <section>
          <span>Thread CPU</span>
          <strong>{warm ? "Warming up" : `${totalCpu.toFixed(1)}%`}</strong>
          <Spark values={history.map((h) => h.cpu)} />
          <small>100% = one logical core</small>
        </section>
        <section>
          <span>Thread memory</span>
          <strong>{view ? memory(totalRss) : "..."}</strong>
          <Spark values={history.map((h) => h.rss)} />
          <small>Summed resident memory (RSS)</small>
        </section>
        <section>
          <span>Machine CPU</span>
          <strong>
            {view?.cpu == null ? "Warming up" : `${view.cpu.toFixed(1)}%`}
          </strong>
          <progress max={100} value={view?.cpu ?? 0} />
          <small>
            {view?.cores ?? "?"} logical cores · all visible workloads
          </small>
        </section>
        <section>
          <span>Machine memory</span>
          <strong>
            {view ? memory(view.totalMemory - view.availableMemory) : "..."}
          </strong>
          <progress
            max={view?.totalMemory || 1}
            value={view ? view.totalMemory - view.availableMemory : 0}
          />
          <small>
            {view
              ? `${memory(view.availableMemory)} available of ${memory(view.totalMemory)}`
              : "Reading memory"}
          </small>
        </section>
      </div>
      <div className="top-toolbar top-filters">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter threads..."
          aria-label="Filter threads"
        />
        <label>
          Sort{" "}
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="cpu">CPU</option>
            <option value="memory">Memory</option>
            <option value="processes">Processes</option>
            <option value="title">Thread name</option>
          </select>
        </label>
        <span className="top-muted">
          {rows.length} {rows.length === 1 ? "thread" : "threads"}
        </span>
      </div>
      <div className="top-table-wrap">
        <table className="top-table">
          <thead>
            <tr>
              <th>Thread / process</th>
              <th>CPU %</th>
              <th>Memory</th>
              <th>Processes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id}>
                <td>
                  <details>
                    <summary>
                      <span className="top-thread-name">{t.title}</span>
                      <small>
                        {t.status} · {t.id}
                      </small>
                    </summary>
                    <div className="top-processes">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => navigate.toThread(t.id)}
                      >
                        Open thread
                      </Button>
                      <table aria-label={`Processes for ${t.title}`}>
                        <thead>
                          <tr>
                            <th>Process</th>
                            <th>PID</th>
                            <th>CPU %</th>
                            <th>Memory</th>
                          </tr>
                        </thead>
                        <tbody>
                          {t.processes.map((p) => (
                            <tr key={p.pid}>
                              <td>{p.name}</td>
                              <td>{p.pid}</td>
                              <td>{warm ? "-" : p.cpu.toFixed(1)}</td>
                              <td>{memory(p.rss)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {t.count > t.processes.length && (
                        <small>
                          Showing {t.processes.length} of {t.count} processes.
                          Totals include all processes in this thread.
                        </small>
                      )}
                    </div>
                  </details>
                </td>
                <td className="top-number">{warm ? "-" : t.cpu.toFixed(1)}</td>
                <td className="top-number">{memory(t.rss)}</td>
                <td className="top-number">{t.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && (
          <p className="top-empty" role="status">
            {!view
              ? error
                ? "Unable to read this machine."
                : "Reading processes..."
              : query
                ? "No threads match your filter."
                : "No processes attributed to BB threads on this machine."}
          </p>
        )}
      </div>
      <p className="top-note">
        Shows processes that can be linked to a thread. Some agent runtimes and
        shared services cannot be assigned. Memory can count shared pages more
        than once.
      </p>
      {view && (
        <p className="top-note">
          {view.scanned} visible processes · {view.unattributed} outside
          attributed threads · {view.unreadable} inaccessible or exited during
          sampling. Machine totals follow the host OS and can include workloads
          outside BB.{" "}
          {view.truncated ? "Results reached the collection limit." : ""}
        </p>
      )}
    </>
  );
}
export function TopPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [hostId, setHostId] = useState("");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    rpc.call("machines").then(
      (list) => {
        if (!active) return;
        setMachines(list);
        setLoaded(true);
        let saved = "";
        try {
          saved = localStorage.getItem("bb-top-machine") ?? "";
        } catch {
          /* storage disabled */
        }
        setHostId(
          list.find((m) => m.id === saved)?.id ??
            (list.filter((m) => m.status === "connected").length === 1
              ? list.find((m) => m.status === "connected")!.id
              : ""),
        );
      },
      (cause) => {
        if (active) {
          setError(String(cause));
          setLoaded(true);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [rpc]);
  const selected = machines.find((m) => m.id === hostId);
  return (
    <div className="bb-top">
      <div className="top-page">
        <header>
          <div>
            <h1>BB Top</h1>
            <p>See which threads are using your machine.</p>
          </div>
          <label>
            Machine{" "}
            <select
              aria-label="Machine"
              value={hostId}
              onChange={(e) => {
                setHostId(e.target.value);
                try {
                  localStorage.setItem("bb-top-machine", e.target.value);
                } catch {
                  /* storage disabled */
                }
              }}
            >
              <option value="">Choose a machine</option>
              {machines.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} · {m.status}
                </option>
              ))}
            </select>
          </label>
        </header>
        {error && (
          <p role="alert" className="top-error">
            {error}
          </p>
        )}
        {selected ? (
          <Monitor key={selected.id} machine={selected} />
        ) : (
          <p className="top-empty">
            {loaded
              ? "Choose the machine you want to monitor."
              : "Loading machines..."}
          </p>
        )}
      </div>
    </div>
  );
}
export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "monitor",
    title: "BB Top",
    icon: "Activity",
    path: "monitor",
    component: TopPage,
  });
});
