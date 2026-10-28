import { useEffect, useState } from "react";
import { Input } from "./components/ui/input.js";
import { Button } from "./components/ui/button.js";
import { priorities, sorts, type TaskFilters, type SortKey } from "./model.js";
const control =
  "rounded-md border border-border bg-background px-3 py-2 text-sm";
export function TaskControls({
  project,
  filters,
  onChange,
  perPage,
  onPageSize,
  busy,
  onOpen,
}: {
  project: string;
  filters: TaskFilters;
  onChange: (f: TaskFilters) => void;
  perPage: number;
  onPageSize: (n: number) => void;
  busy: boolean;
  onOpen: (id: string) => void;
}) {
  const [draft, setDraft] = useState(filters);
  const [openId, setOpenId] = useState("");
  // Sorting should not discard filters the user is still editing.
  const appliedFilterKey = JSON.stringify([
    filters.q,
    filters.state,
    filters.priority,
    filters.label,
    filters.assignedTo,
    filters.createdBy,
    filters.stateId,
    filters.fromDate,
    filters.toDate,
  ]);
  useEffect(() => setDraft(filters), [project, appliedFilterKey]);
  return (
    <div className="space-y-3">
      <form
        className="space-y-3 rounded-lg border border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          onChange({
            ...draft,
            sort: filters.sort,
            direction: filters.direction,
          });
        }}
      >
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 text-sm">
            Search
            <Input
              disabled={busy}
              aria-label="Search tasks"
              placeholder="Task ID or text…"
              maxLength={200}
              value={draft.q ?? ""}
              onChange={(e) => setDraft((v) => ({ ...v, q: e.target.value }))}
            />
          </label>
          <label className="text-sm">
            State
            <select
              className={control + " block"}
              aria-label="State"
              disabled={busy}
              value={draft.state ?? ""}
              onChange={(e) =>
                setDraft((v) => ({ ...v, state: e.target.value }))
              }
            >
              {[
                "",
                "backlog",
                "unstarted",
                "started",
                "completed",
                "cancelled",
              ].map((v) => (
                <option key={v} value={v}>
                  {v || "All states"}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Priority
            <select
              className={control + " block"}
              aria-label="Filter priority"
              disabled={busy}
              value={draft.priority ?? ""}
              onChange={(e) =>
                setDraft((v) => ({
                  ...v,
                  priority:
                    e.target.value === "" ? undefined : Number(e.target.value),
                }))
              }
            >
              <option value="">Any priority</option>
              {priorities.map((p, i) => (
                <option key={i} value={i}>
                  {p}
                </option>
              ))}
            </select>
          </label>
        </div>
        {project && (
          <details>
            <summary className="cursor-pointer text-sm">More filters</summary>
            <div
              className="mt-3 grid gap-3"
              style={{
                gridTemplateColumns:
                  "repeat(auto-fit,minmax(min(100%,14rem),1fr))",
              }}
            >
              <label className="text-sm">
                Label name
                <Input
                  aria-label="Label filter"
                  disabled={busy}
                  maxLength={200}
                  value={draft.label ?? ""}
                  onChange={(e) =>
                    setDraft((v) => ({ ...v, label: e.target.value }))
                  }
                />
              </label>
              {project && (
                <>
                  {(
                    [
                      ["assignedTo", "Assignee"],
                      ["createdBy", "Creator"],
                      ["stateId", "Workflow state ID"],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key} className="text-sm">
                      {label}
                      <Input
                        aria-label={label}
                        disabled={busy}
                        placeholder={
                          key === "stateId" ? "UUID" : "Username or user ID"
                        }
                        value={draft[key] ?? ""}
                        onChange={(e) =>
                          setDraft((v) => ({
                            ...v,
                            [key]: e.target.value || undefined,
                          }))
                        }
                      />
                    </label>
                  ))}
                  <label className="text-sm">
                    Created from
                    <Input
                      type="date"
                      aria-label="Created from"
                      disabled={busy}
                      max={draft.toDate || undefined}
                      value={draft.fromDate ?? ""}
                      onChange={(e) =>
                        setDraft((v) => ({
                          ...v,
                          fromDate: e.target.value || undefined,
                        }))
                      }
                    />
                  </label>
                  <label className="text-sm">
                    Created through
                    <Input
                      type="date"
                      aria-label="Created through"
                      disabled={busy}
                      min={draft.fromDate || undefined}
                      value={draft.toDate ?? ""}
                      onChange={(e) =>
                        setDraft((v) => ({
                          ...v,
                          toDate: e.target.value || undefined,
                        }))
                      }
                    />
                  </label>
                  <p className="text-xs text-muted-foreground">
                    Use IDs from task information or Bureaucat. Dates refer to
                    creation dates in UTC.
                  </p>
                </>
              )}
            </div>
          </details>
        )}
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy}>Apply filters</Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => (
              setDraft({}),
              onChange({ sort: filters.sort, direction: filters.direction })
            )}
          >
            Clear filters
          </Button>
        </div>
      </form>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm">
          Sort
          <select
            aria-label="Sort tasks"
            className={control + " ml-2"}
            disabled={busy}
            value={filters.sort ?? "default"}
            onChange={(e) => {
              const sort = e.target.value as SortKey;
              onChange({
                ...filters,
                sort,
                direction: [
                  "priority",
                  "comments",
                  "created",
                  "updated",
                ].includes(sort)
                  ? "desc"
                  : "asc",
              });
            }}
          >
            {sorts
              .filter((v) => project || !["created", "updated"].includes(v))
              .map((v) => (
                <option key={v} value={v}>
                  {
                    {
                      default: "Service order",
                      title: "Title",
                      priority: "Priority",
                      state: "State",
                      number: "Task number",
                      comments: "Comment count",
                      created: "Created",
                      updated: "Updated",
                    }[v]
                  }
                </option>
              ))}
          </select>
        </label>
        {filters.sort && filters.sort !== "default" && (
          <select
            aria-label="Sort direction"
            className={control}
            disabled={busy}
            value={filters.direction ?? "asc"}
            onChange={(e) =>
              onChange({
                ...filters,
                direction: e.target.value as "asc" | "desc",
              })
            }
          >
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
        )}
        <label className="text-sm">
          Per page
          <select
            aria-label="Tasks per page"
            className={control + " ml-2"}
            disabled={busy}
            value={perPage}
            onChange={(e) => onPageSize(Number(e.target.value))}
          >
            {[15, 30, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          onOpen(openId.trim());
        }}
      >
        <Input
          aria-label="Open task ID"
          placeholder="PROJECT-123"
          pattern="[A-Za-z][A-Za-z0-9_-]*-[1-9][0-9]*"
          required
          disabled={busy}
          value={openId}
          onChange={(e) => setOpenId(e.target.value)}
        />
        <Button variant="outline" disabled={busy}>
          Open task
        </Button>
      </form>
    </div>
  );
}
