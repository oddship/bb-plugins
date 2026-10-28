import type { Task } from "./contract.js";
export const priorities = ["None", "Low", "Medium", "High", "Urgent"];
export const sorts = [
  "default",
  "title",
  "priority",
  "state",
  "number",
  "comments",
  "created",
  "updated",
] as const;
export type SortKey = (typeof sorts)[number];
export function taskUrl(task: Task, baseUrl: string) {
  return `${baseUrl}/projects/${encodeURIComponent(task.project_key)}/tasks/${task.task_number}`;
}
export type TaskFilters = {
  q?: string;
  state?: string;
  priority?: number;
  label?: string;
  stateId?: string;
  assignedTo?: string;
  createdBy?: string;
  fromDate?: string;
  toDate?: string;
  sort?: SortKey;
  direction?: "asc" | "desc";
};
export function filterAndSort(tasks: Task[], f: TaskFilters) {
  const query = (f.q ?? "").toLowerCase();
  const label = (f.label ?? "").toLowerCase();
  const filtered = tasks.filter(
    (t) =>
      (!query ||
        `${t.task_id} ${t.title} ${(t.description ?? "").replace(/<[^>]*>/g, " ")}`
          .toLowerCase()
          .includes(query)) &&
      (!f.state || t.state_type === f.state) &&
      (f.priority === undefined || t.priority === f.priority) &&
      (!label || t.labels?.some((l) => l.name.toLowerCase().includes(label))) &&
      (!f.stateId || t.state_id === f.stateId) &&
      (!f.assignedTo ||
        t.assignees?.some(
          (a) =>
            a.user_id === f.assignedTo ||
            a.username.toLowerCase() ===
              (f.assignedTo ?? "").replace(/^@/, "").toLowerCase(),
        )) &&
      (!f.createdBy ||
        t.created_by === f.createdBy ||
        t.creator_username?.toLowerCase() ===
          (f.createdBy ?? "").replace(/^@/, "").toLowerCase()) &&
      (!f.fromDate ||
        (!!t.created_at && t.created_at.slice(0, 10) >= f.fromDate)) &&
      (!f.toDate || (!!t.created_at && t.created_at.slice(0, 10) <= f.toDate)),
  );
  if (!f.sort || f.sort === "default") return filtered;
  const key = f.sort;
  const direction = f.direction === "desc" ? -1 : 1;
  const value = (t: Task): string | number | undefined =>
    key === "title"
      ? t.title.toLowerCase()
      : key === "priority"
        ? t.priority
        : key === "state"
          ? t.state_name.toLowerCase()
          : key === "number"
            ? t.task_number
            : key === "comments"
              ? (t.comment_count ?? 0)
              : key === "created"
                ? t.created_at
                : t.updated_at;
  return filtered.sort((a, b) => {
    const av = value(a),
      bv = value(b);
    if (av === undefined || av === "")
      return bv === undefined || bv === ""
        ? a.task_id.localeCompare(b.task_id)
        : 1;
    if (bv === undefined || bv === "") return -1;
    const cmp =
      typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av).localeCompare(String(bv));
    return cmp * direction || a.task_id.localeCompare(b.task_id);
  });
}

export function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as T;
}
