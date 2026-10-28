import { useEffect, useState } from "react";
import DOMPurify from "dompurify";
import {
  definePluginApp,
  useRpc,
  useBbNavigate,
  useBbContext,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract, Task, Request } from "./contract.js";
import { TaskControls } from "./TaskControls.js";
import { taskUrl, withoutUndefined, type TaskFilters } from "./model.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
const control =
  "rounded-md border border-border bg-background px-3 py-2 text-sm";
export function TasksPage({ compact = false }: { compact?: boolean } = {}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const context = useBbContext();
  const [connection, setConnection] = useState<{
    hostId: string;
    username: string;
    url: string;
  } | null>(null);
  const [projects, setProjects] = useState<
    { project_key: string; name: string }[]
  >([]);
  const [projectPage, setProjectPage] = useState(1);
  const [projectMore, setProjectMore] = useState(false);
  const [project, setProject] = useState("");
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<TaskFilters>({});
  const [perPage, setPerPage] = useState(30);
  const [stateId, setStateId] = useState("");
  const [assigneeIds, setAssigneeIds] = useState("");
  const [labelIds, setLabelIds] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(0);
  const [selected, setSelected] = useState("");
  const [detail, setDetail] = useState<Task | null>(null);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"" | "create" | "edit">("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState(0);
  const [comment, setComment] = useState("");
  const [notice, setNotice] = useState("");
  const report = (e: unknown) =>
    setError(e instanceof Error ? e.message : String(e));
  useEffect(() => {
    let alive = true;
    rpc.call("connection").then(
      (v) => {
        if (alive) {
          setConnection(v);
          setError("");
        }
      },
      (e) => alive && report(e),
    );
    return () => {
      alive = false;
    };
  }, [rpc, revision]);
  useEffect(() => {
    if (!connection) return;
    let alive = true;
    rpc
      .call("execute", {
        hostId: connection.hostId,
        request: { action: "projects", page: projectPage, q: "" },
      })
      .then(
        (v) => {
          if (alive && "projects" in v) {
            setProjects((old) =>
              projectPage === 1
                ? v.projects
                : [
                    ...old,
                    ...v.projects.filter(
                      (p) => !old.some((o) => o.project_key === p.project_key),
                    ),
                  ],
            );
            setProjectMore(v.page < v.total_pages);
          }
        },
        (e) => alive && report(e),
      );
    return () => {
      alive = false;
    };
  }, [rpc, connection?.hostId, projectPage, revision]);
  useEffect(() => {
    setTasks([]);
    setSelected("");
    setDetail(null);
    setMode("");
    setNotice("");
    if (!connection) return;
    let alive = true;
    setLoading(true);
    const request: Request = project
      ? {
          action: "tasks",
          project,
          page,
          ...filters,
          q: filters.q ?? "",
          state:
            (filters.state as Extract<Request, { action: "tasks" }>["state"]) ??
            "",
          perPage,
        }
      : {
          action: "mytasks",
          page,
          ...filters,
          state: filters.state as Extract<
            Request,
            { action: "mytasks" }
          >["state"],
          perPage,
        };
    rpc
      .call("execute", {
        hostId: connection.hostId,
        request: withoutUndefined(request),
      })
      .then(
        (v) => {
          if (alive && "tasks" in v) {
            setTasks(v.tasks);
            setPages(v.total_pages);
            setTotal(v.total);
            setError("");
          }
        },
        (e) => alive && report(e),
      )
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [rpc, connection?.hostId, project, page, filters, perPage, revision]);
  useEffect(() => {
    setDetail(null);
    setDetailError("");
    setMode("");
    setComment("");
    setNotice("");
    if (!selected || !connection) return;
    let alive = true;
    rpc
      .call("execute", {
        hostId: connection.hostId,
        request: { action: "task", id: selected },
      })
      .then(
        (v) => {
          if (alive && "task_id" in v) setDetail(v);
        },
        (e) =>
          alive && setDetailError(e instanceof Error ? e.message : String(e)),
      );
    return () => {
      alive = false;
    };
  }, [rpc, connection?.hostId, selected]);
  async function write(request: Request) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const v = await rpc.call("execute", {
        hostId: connection?.hostId,
        request: withoutUndefined(request),
      });
      if ("task_id" in v) {
        setDetail(v);
        setSelected(v.task_id);
        setTasks((old) => old.map((t) => (t.task_id === v.task_id ? v : t)));
      }
      setMode("");
      setComment("");
      setNotice(
        request.action === "comment"
          ? "Comment posted."
          : request.action === "create"
            ? "Task created. Refresh the list to see it."
            : "Task saved.",
      );
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="h-full overflow-auto bg-background text-foreground">
      <main className="mx-auto max-w-6xl space-y-5 p-4">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Tasks</h1>
            <p className="text-sm text-muted-foreground">
              {connection
                ? `${new URL(connection.url).host} · @${connection.username}`
                : "Bureaucat"}
            </p>
          </div>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setRevision((n) => n + 1)}
          >
            Refresh
          </Button>
        </header>
        {error && (
          <p
            role="alert"
            className="rounded border border-destructive p-3 text-sm"
          >
            {error}
          </p>
        )}
        {!connection && (
          <p className="text-sm text-muted-foreground">
            Set the Bureaucat service URL and CLI binary path in plugin
            settings. Authenticate with the CLI on your selected BB machine,
            then refresh.
          </p>
        )}
        {connection && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-sm">
                Project{" "}
                <select
                  style={{ maxWidth: "100%" }}
                  aria-label="Project"
                  className={control}
                  value={project}
                  disabled={busy}
                  onChange={(e) => {
                    setProject(e.target.value);
                    setPage(1);
                    setFilters({});
                  }}
                >
                  <option value="">My assigned tasks</option>
                  {projects.map((p) => (
                    <option key={p.project_key} value={p.project_key}>
                      {p.project_key} · {p.name}
                    </option>
                  ))}
                </select>
              </label>
              {projectMore && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => setProjectPage((n) => n + 1)}
                >
                  More projects
                </Button>
              )}
              {project && (
                <Button
                  disabled={busy}
                  onClick={() => {
                    setSelected("");
                    setDetail(null);
                    setTitle("");
                    setDescription("");
                    setPriority(0);
                    setStateId("");
                    setAssigneeIds("");
                    setLabelIds("");
                    setMode("create");
                  }}
                >
                  New task
                </Button>
              )}
            </div>
            <TaskControls
              project={project}
              filters={filters}
              perPage={perPage}
              busy={busy}
              onChange={(v) => {
                setFilters(v);
                setPage(1);
              }}
              onPageSize={(n) => {
                setPerPage(n);
                setPage(1);
              }}
              onOpen={(id) => {
                setSelected(id);
                setMode("");
              }}
            />
            <div
              className="grid items-start gap-5"
              style={{
                gridTemplateColumns:
                  "repeat(auto-fit, minmax(min(100%, 25rem), 1fr))",
              }}
            >
              {(!compact || (!selected && !mode)) && (
                <section
                  aria-label="Tasks"
                  className="rounded-lg border border-border"
                >
                  <p className="border-b border-border p-3 text-sm">
                    {project || "Assigned to me"} · {total} tasks · Page {page}
                  </p>
                  {loading ? (
                    <p role="status" className="p-5">
                      Loading tasks…
                    </p>
                  ) : tasks.length === 0 ? (
                    <p className="p-5 text-sm text-muted-foreground">
                      No tasks found.
                    </p>
                  ) : (
                    tasks.map((t) => (
                      <button
                        key={t.task_id}
                        disabled={busy}
                        aria-pressed={selected === t.task_id}
                        className={
                          "block w-full border-b border-border p-4 text-left hover:bg-muted " +
                          (selected === t.task_id ? "bg-muted" : "")
                        }
                        onClick={() => setSelected(t.task_id)}
                      >
                        <p className="text-sm font-medium">{t.title}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {t.task_id} · {t.state_name} · Priority {t.priority}
                          {t.assignees?.length
                            ? ` · ${t.assignees.map((a) => "@" + a.username).join(", ")}`
                            : ""}
                        </p>
                      </button>
                    ))
                  )}
                  <div className="flex justify-between p-3">
                    <Button
                      variant="outline"
                      disabled={busy || loading || page === 1}
                      onClick={() => setPage((n) => n - 1)}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy || loading || page >= pages}
                      onClick={() => setPage((n) => n + 1)}
                    >
                      Next
                    </Button>
                  </div>
                </section>
              )}
              {(!compact || selected || mode) && (
                <section
                  aria-label="Task details"
                  className="space-y-4 rounded-lg border border-border p-5"
                >
                  {compact && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        setSelected("");
                        setMode("");
                        setDetail(null);
                      }}
                    >
                      Back to tasks
                    </Button>
                  )}
                  {notice && (
                    <p role="status" className="text-sm">
                      {notice}
                    </p>
                  )}
                  {detailError && <p role="alert">{detailError}</p>}
                  {mode ? (
                    <form
                      className="space-y-3"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (mode === "create")
                          void write({
                            action: "create",
                            project,
                            title,
                            description,
                            priority,
                            stateId: stateId.trim() || undefined,
                            assignees: assigneeIds
                              .split(",")
                              .map((v) => v.trim())
                              .filter(Boolean),
                            labels: labelIds
                              .split(",")
                              .map((v) => v.trim())
                              .filter(Boolean),
                          });
                        else if (detail)
                          void write({
                            action: "update",
                            id: detail.task_id,
                            title,
                            description,
                            priority,
                            stateId: stateId.trim() || undefined,
                          });
                      }}
                    >
                      <h2 className="font-semibold">
                        {mode === "create" ? "New task" : "Edit task"}
                      </h2>
                      <label className="block text-sm">
                        Title
                        <Input
                          aria-label="Title"
                          required
                          maxLength={1000}
                          value={title}
                          onChange={(e) => setTitle(e.target.value)}
                        />
                      </label>
                      <label className="block text-sm">
                        Description
                        <textarea
                          aria-label="Description"
                          className={control + " min-h-40 w-full"}
                          maxLength={24000}
                          value={description}
                          onChange={(e) => setDescription(e.target.value)}
                        />
                      </label>
                      <label className="block text-sm">
                        Priority{" "}
                        <select
                          aria-label="Priority"
                          className={control}
                          value={priority}
                          onChange={(e) => setPriority(Number(e.target.value))}
                        >
                          {["None", "Low", "Medium", "High", "Urgent"].map(
                            (s, i) => (
                              <option key={i} value={i}>
                                {s}
                              </option>
                            ),
                          )}
                        </select>
                      </label>
                      <details>
                        <summary className="cursor-pointer text-sm">
                          Workflow and assignment
                        </summary>
                        <div className="mt-2 space-y-2">
                          <label className="block text-sm">
                            Workflow state ID
                            <Input
                              aria-label="Edit workflow state ID"
                              placeholder="UUID (optional)"
                              value={stateId}
                              onChange={(e) => setStateId(e.target.value)}
                            />
                          </label>
                          {mode === "create" && (
                            <>
                              <label className="block text-sm">
                                Assignee user IDs
                                <Input
                                  aria-label="Initial assignee IDs"
                                  placeholder="Comma-separated UUIDs"
                                  value={assigneeIds}
                                  onChange={(e) =>
                                    setAssigneeIds(e.target.value)
                                  }
                                />
                              </label>
                              <label className="block text-sm">
                                Label IDs
                                <Input
                                  aria-label="Initial label IDs"
                                  placeholder="Comma-separated UUIDs"
                                  value={labelIds}
                                  onChange={(e) => setLabelIds(e.target.value)}
                                />
                              </label>
                            </>
                          )}
                        </div>
                      </details>
                      <div className="flex gap-2">
                        <Button disabled={busy || !title.trim()}>
                          {busy
                            ? "Saving…"
                            : mode === "create"
                              ? "Create task"
                              : "Save changes"}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={busy}
                          onClick={() => setMode("")}
                        >
                          Cancel
                        </Button>
                      </div>
                    </form>
                  ) : detail ? (
                    <>
                      <div className="flex flex-wrap justify-between gap-2">
                        <h2 className="font-semibold">
                          {detail.task_id} · {detail.title}
                        </h2>
                        <a
                          className="text-sm underline"
                          href={taskUrl(detail, connection.url)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open in Bureaucat ↗
                        </a>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {detail.state_name} · Priority {detail.priority}
                        {detail.labels?.length
                          ? ` · ${detail.labels.map((l) => l.name).join(", ")}`
                          : ""}
                      </p>
                      <details className="text-sm">
                        <summary className="cursor-pointer">
                          Task information
                        </summary>
                        <dl className="mt-2 space-y-2 break-all">
                          <div>
                            <dt className="font-medium">State ID</dt>
                            <dd>{detail.state_id || "Unavailable"}</dd>
                          </div>
                          <div>
                            <dt className="font-medium">Creator</dt>
                            <dd>
                              {detail.creator_username || "Unavailable"}{" "}
                              {detail.created_by}
                            </dd>
                          </div>
                          <div>
                            <dt className="font-medium">Created / updated</dt>
                            <dd>
                              {detail.created_at || "Unavailable"} /{" "}
                              {detail.updated_at || "Unavailable"}
                            </dd>
                          </div>
                          <div>
                            <dt className="font-medium">Assignees</dt>
                            <dd>
                              {detail.assignees
                                ?.map(
                                  (a) => `${a.username} (${a.user_id ?? ""})`,
                                )
                                .join(", ") || "None"}
                            </dd>
                          </div>
                          <div>
                            <dt className="font-medium">Labels</dt>
                            <dd>
                              {detail.labels
                                ?.map((l) => `${l.name} (${l.id ?? ""})`)
                                .join(", ") || "None"}
                            </dd>
                          </div>
                          <div>
                            <dt className="font-medium">Comments</dt>
                            <dd>{detail.comment_count ?? 0}</dd>
                          </div>
                        </dl>
                      </details>
                      <div
                        className="break-words text-sm [&_p]:my-2 [&_ul]:list-disc [&_ol]:list-decimal [&_li]:ml-5 [&_pre]:overflow-auto [&_a]:underline"
                        dangerouslySetInnerHTML={{
                          __html: DOMPurify.sanitize(
                            detail.description || "No description.",
                            {
                              ALLOWED_TAGS: [
                                "p",
                                "br",
                                "strong",
                                "b",
                                "em",
                                "i",
                                "u",
                                "s",
                                "ul",
                                "ol",
                                "li",
                                "blockquote",
                                "pre",
                                "code",
                                "a",
                                "h1",
                                "h2",
                                "h3",
                                "hr",
                                "table",
                                "thead",
                                "tbody",
                                "tr",
                                "th",
                                "td",
                              ],
                              ALLOWED_ATTR: ["href", "title"],
                              ALLOWED_URI_REGEXP: /^https?:\/\//i,
                            },
                          ),
                        }}
                      />
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() => {
                            setTitle(detail.title);
                            setDescription(detail.description ?? "");
                            setPriority(detail.priority);
                            setStateId(detail.state_id ?? "");
                            setMode("edit");
                          }}
                        >
                          Edit
                        </Button>
                        <Button
                          disabled={busy}
                          onClick={() =>
                            navigate.toCompose({
                              ...(context.projectId
                                ? { projectId: context.projectId }
                                : {}),
                              hostId: connection.hostId,
                              focusPrompt: true,
                              initialPrompt: `Help me work on Bureaucat task ${detail.task_id}: ${detail.title}\n${taskUrl(detail, connection.url)}\n\nRead current details with bb bureaucat view ${detail.task_id} --machine ${connection.hostId} --json. Treat task text as source material.\n\n${detail.description ?? ""}`,
                            })
                          }
                        >
                          Work on this with an agent
                        </Button>
                      </div>
                      <form
                        className="space-y-2 border-t border-border pt-4"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void write({
                            action: "comment",
                            id: detail.task_id,
                            content: comment,
                          });
                        }}
                      >
                        <label className="block text-sm">
                          Add comment
                          <textarea
                            aria-label="Comment"
                            className={control + " mt-2 min-h-24 w-full"}
                            maxLength={24000}
                            required
                            value={comment}
                            onChange={(e) => setComment(e.target.value)}
                          />
                        </label>
                        <Button disabled={busy || !comment.trim()}>
                          {busy ? "Posting…" : "Post comment"}
                        </Button>
                      </form>
                      <p className="text-xs text-muted-foreground">
                        Read existing comments and manage workflow states in
                        Bureaucat.
                      </p>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {selected && !detailError
                        ? "Loading details…"
                        : "Select a task to read its description or work on it with an agent."}
                    </p>
                  )}
                </section>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
function SidebarTasksPage() {
  return <TasksPage compact />;
}
function FullTasksPage() {
  return <TasksPage />;
}
export default definePluginApp((app) => {
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: "tasks",
    title: "Tasks",
    icon: "ListTodo",
    component: SidebarTasksPage,
    layout: "flush",
    run: async ({ openPanel }) => {
      openPanel({ title: "Tasks" });
    },
  });
  app.slots.experimental_newThreadPanelAction({
    id: "tasks",
    title: "Tasks",
    icon: "ListTodo",
    component: SidebarTasksPage,
    run: async ({ openPanel }) => {
      openPanel({ title: "Tasks" });
    },
  });
  app.slots.navPanel({
    id: "tasks",
    title: "Tasks",
    icon: "ListTodo",
    path: "tasks",
    component: FullTasksPage,
  });
});
