import { execFile } from "node:child_process";
import { z } from "zod";
import { itemSchema, repoSchema, commentSchema } from "./contract.js";
export type Run = (args: string[], signal?: AbortSignal) => Promise<unknown>;
export const runTea: Run = (args, signal) =>
  new Promise((resolve, reject) => {
    execFile(
      "tea",
      args,
      {
        signal,
        timeout: 20000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout) => {
        if (error)
          return reject(
            new Error(
              (error as NodeJS.ErrnoException).code === "ENOENT"
                ? "tea is not on this machine’s PATH. Install tea and run tea login add."
                : "tea request failed. Check the selected login, repository permissions, and connection with tea login list and tea api user.",
            ),
          );
        try {
          const value = JSON.parse(stdout);
          if (
            value &&
            !Array.isArray(value) &&
            typeof value === "object" &&
            "message" in value &&
            !("number" in value)
          )
            throw new Error("API error");
          resolve(value);
        } catch {
          reject(
            new Error(
              "tea returned an API error or invalid JSON. Verify that this tea version supports tea api and that the login is valid.",
            ),
          );
        }
      },
    );
  });
const rawItem = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullish(),
  html_url: z.string().nullish(),
  state: z.string(),
  user: z.object({ login: z.string() }).nullish(),
  updated_at: z.string().nullish(),
  labels: z.array(z.object({ name: z.string() })).nullish(),
  head: z.object({ ref: z.string() }).nullish(),
  base: z.object({ ref: z.string() }).nullish(),
  merged: z.boolean().optional(),
  pull_request: z.unknown().optional(),
});
export function normalizeItem(value: unknown) {
  const r = rawItem.parse(value);
  return itemSchema.parse({
    number: r.number,
    title: r.title,
    body: (r.body ?? "").slice(0, 24000),
    url: safeUrl(r.html_url),
    state: r.state,
    author: r.user?.login ?? "",
    updatedAt: r.updated_at ?? "",
    labels: (r.labels ?? []).map((l) => l.name),
    head: r.head?.ref ?? "",
    base: r.base?.ref ?? "",
    merged: r.merged ?? false,
  });
}
export function safeUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : "";
  } catch {
    return "";
  }
}
export function createTea(run: Run = runTea) {
  const api = (login: string, endpoint: string, signal?: AbortSignal) =>
    run(["api", "--login", login, "--method", "GET", endpoint], signal);
  const root = (repo: string) =>
    "repos/" + repo.split("/").map(encodeURIComponent).join("/");
  return {
    async logins(signal?: AbortSignal) {
      const rows = z
        .array(
          z.object({ name: z.string(), url: z.string(), user: z.string() }),
        )
        .parse(await run(["login", "list", "--output", "json"], signal));
      return rows.map((r) => ({ ...r, url: safeUrl(r.url) }));
    },
    async repos(login: string, page: number, signal?: AbortSignal) {
      const rows = z
        .array(
          z.object({
            full_name: z.string(),
            html_url: z.string(),
            description: z.string().nullish(),
          }),
        )
        .parse(await api(login, `user/repos?limit=30&page=${page}`, signal));
      return rows.map((r) =>
        repoSchema.parse({
          name: r.full_name,
          url: safeUrl(r.html_url),
          description: (r.description ?? "").slice(0, 500),
        }),
      );
    },
    async items(
      login: string,
      repo: string,
      kind: "issues" | "pulls",
      state: string,
      page: number,
      signal?: AbortSignal,
    ) {
      const rows = z
        .array(rawItem)
        .parse(
          await api(
            login,
            `${root(repo)}/${kind}?state=${state}&sort=updated&limit=30&page=${page}${kind === "issues" ? "&type=issues" : ""}`,
            signal,
          ),
        );
      return rows
        .filter((r) => kind !== "issues" || !r.pull_request)
        .map(normalizeItem);
    },
    async detail(
      login: string,
      repo: string,
      kind: "issues" | "pulls",
      number: number,
      signal?: AbortSignal,
    ) {
      const item = normalizeItem(
        await api(login, `${root(repo)}/${kind}/${number}`, signal),
      );
      const rows = z
        .array(
          z.object({
            user: z.object({ login: z.string() }).nullish(),
            body: z.string().nullish(),
            html_url: z.string().nullish(),
          }),
        )
        .parse(
          await api(
            login,
            `${root(repo)}/issues/${number}/comments?limit=30`,
            signal,
          ),
        );
      return {
        item,
        comments: rows.map((r) =>
          commentSchema.parse({
            author: r.user?.login ?? "",
            body: (r.body ?? "").slice(0, 8000),
            url: safeUrl(r.html_url),
          }),
        ),
      };
    },
  };
}
