import { z } from "zod";

export const hostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(
    /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?::[0-9]{1,5})?$/,
    "Use a hostname, optionally with a port",
  );
export const pathSchema = z
  .string()
  .trim()
  .max(512)
  .refine(
    (v) =>
      v.split("/").length >= 2 &&
      v.split("/").every((s) => /^[\w.-]+$/.test(s) && s !== "." && s !== ".."),
    "Use a namespace/project path (nested groups are supported)",
  );
export const repoSchema = z
  .string()
  .transform((v) => v.trim())
  .refine((v) => {
    const i = v.indexOf("/");
    return (
      i > 0 &&
      hostSchema.safeParse(v.slice(0, i)).success &&
      pathSchema.safeParse(v.slice(i + 1)).success
    );
  }, "Use host/namespace/project");
export const kindSchema = z.enum(["issue", "mr"]);
export const itemSchema = z.object({
  repo: repoSchema,
  kind: kindSchema,
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  url: z.string().url(),
  state: z.string(),
  author: z.string(),
  assignees: z.array(z.string()),
  reviewers: z.array(z.string()),
  labels: z.array(z.string()),
  draft: z.boolean(),
  sourceBranch: z.string(),
  targetBranch: z.string(),
  pipeline: z.string(),
  updatedAt: z.string(),
});
export type Item = z.infer<typeof itemSchema>;
export const trackedSchema = z.object({
  repo: repoSchema,
  projectId: z.string().nullable(),
});
export type Tracked = z.infer<typeof trackedSchema>;
export const noteSchema = z.object({
  id: z.number(),
  author: z.string(),
  body: z.string(),
  createdAt: z.string(),
  system: z.boolean(),
});
export const linkSchema = z.object({
  repo: repoSchema,
  kind: kindSchema,
  number: z.number(),
  threadId: z.string(),
  createdAt: z.string(),
});
export const selection = z.object({
  repo: repoSchema,
  kind: kindSchema,
  number: z.number().int().positive(),
});
export type Selection = z.infer<typeof selection>;
export function splitRepo(repo: string) {
  const valid = repoSchema.parse(repo);
  const i = valid.indexOf("/");
  return { host: valid.slice(0, i).toLowerCase(), path: valid.slice(i + 1) };
}
export function parseRepo(value: string, defaultHost: string): string {
  const s = value.trim();
  if (s.includes("://") || /^[^/@]+@[^:]+:/.test(s)) {
    const u = new URL(
      s.includes("://") ? s : s.replace(/^[^@]+@([^:]+):/, "ssh://$1/"),
    );
    if (
      !["https:", "http:", "ssh:"].includes(u.protocol) ||
      (u.protocol !== "ssh:" && (u.username || u.password)) ||
      u.search ||
      u.hash
    )
      throw new Error("Use a GitLab repository URL or namespace/project");
    return repoSchema.parse(
      `${u.host.toLowerCase()}/${u.pathname
        .replace(/^\//, "")
        .replace(/\.git\/?$/, "")
        .replace(/\/$/, "")}`,
    );
  }
  const first = s.split("/")[0];
  return repoSchema.parse(
    `${first.includes(".") || first.includes(":") || first === defaultHost ? "" : hostSchema.parse(defaultHost).toLowerCase() + "/"}${s.replace(/\.git$/, "")}`,
  );
}
export function remoteRepo(value: string, hosts: Set<string>): string | null {
  try {
    const repo = parseRepo(value, "gitlab.com");
    return hosts.has(splitRepo(repo).host) ? repo : null;
  } catch {
    return null;
  }
}
export function parseExtras(value: string, host: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,]+/)
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => parseRepo(x, host)),
    ),
  ];
}
const user = z.object({ username: z.string() });
const rawItem = z.object({
  iid: z.number().int().positive(),
  title: z.string(),
  description: z.string().nullable().optional(),
  web_url: z.string().url(),
  state: z.string(),
  author: user.nullable().optional(),
  assignees: z.array(user).optional(),
  reviewers: z.array(user).optional(),
  labels: z.array(z.string()).optional(),
  draft: z.boolean().optional(),
  work_in_progress: z.boolean().optional(),
  source_branch: z.string().optional(),
  target_branch: z.string().optional(),
  head_pipeline: z.object({ status: z.string() }).nullable().optional(),
  updated_at: z.string(),
});
export function normalizeItem(
  raw: unknown,
  repo: string,
  kind: Item["kind"],
): Item {
  const r = rawItem.parse(raw);
  return itemSchema.parse({
    repo,
    kind,
    number: r.iid,
    title: r.title,
    body: (r.description ?? "").slice(0, 50000),
    url: r.web_url,
    state: r.state,
    author: r.author?.username ?? "",
    assignees: r.assignees?.map((x) => x.username) ?? [],
    reviewers: r.reviewers?.map((x) => x.username) ?? [],
    labels: r.labels ?? [],
    draft: r.draft ?? r.work_in_progress ?? false,
    sourceBranch: r.source_branch ?? "",
    targetBranch: r.target_branch ?? "",
    pipeline: r.head_pipeline?.status ?? "",
    updatedAt: r.updated_at,
  });
}
export const listInput = z.object({
  repo: repoSchema.optional(),
  kind: kindSchema.default("issue"),
  state: z.enum(["opened", "closed", "merged", "all"]).default("opened"),
  query: z.string().max(200).default(""),
  page: z.number().int().min(1).max(10000).default(1),
});
