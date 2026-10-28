import { execFile } from "node:child_process";
import { z } from "zod";
import {
  normalizeItem,
  splitRepo,
  type Item,
  type Selection,
  noteSchema,
} from "./model";
export type Runner = (
  args: string[],
  signal?: AbortSignal,
  input?: string,
) => Promise<string>;
export function createRunner(binary: string, lifetime?: AbortSignal): Runner {
  return (args, signal, input) =>
    new Promise((resolve, reject) => {
      const signals = [signal, lifetime].filter((x): x is AbortSignal => !!x);
      const child = execFile(
        binary,
        args,
        {
          encoding: "utf8",
          timeout: 30000,
          maxBuffer: 4 * 1024 * 1024,
          signal: signals.length ? AbortSignal.any(signals) : undefined,
          env: {
            ...process.env,
            GLAB_CHECK_UPDATE: "false",
            NO_COLOR: "1",
            GLAB_NO_PROMPT: "1",
          },
        },
        (error, stdout, stderr) => {
          if (error)
            reject(
              new Error(
                error.code === "ENOENT"
                  ? "glab is not installed on the BB server. Install it and run glab auth login."
                  : `glab failed: ${(stderr || error.message).slice(0, 1500)}`,
              ),
            );
          else resolve(stdout);
        },
      );
      child.stdin?.end(input);
    });
}
export function createGitlab(run: Runner) {
  async function api(
    repo: string,
    endpoint: string,
    method = "GET",
    fields: Record<string, string | number[]> = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    const { host, path } = splitRepo(repo);
    const args = [
      "api",
      "--hostname",
      host,
      "--method",
      method,
      `projects/${encodeURIComponent(path)}${endpoint}`,
    ];
    const input = Object.keys(fields).length
      ? JSON.stringify(fields)
      : undefined;
    if (input) args.push("--input", "-");
    const out = await run(args, signal, input);
    return out.trim() ? JSON.parse(out) : null;
  }
  function endpoint(s: Selection) {
    return `/${s.kind === "issue" ? "issues" : "merge_requests"}/${s.number}`;
  }
  return {
    async status(host: string, signal?: AbortSignal) {
      const r = z
        .object({ username: z.string() })
        .parse(
          JSON.parse(await run(["api", "--hostname", host, "user"], signal)),
        );
      return { host, username: r.username };
    },
    async items(
      repo: string,
      kind: Item["kind"],
      state: string,
      signal?: AbortSignal,
    ) {
      const r = z
        .array(z.unknown())
        .parse(
          await api(
            repo,
            `/${kind === "issue" ? "issues" : "merge_requests"}?state=${encodeURIComponent(state)}&per_page=100&order_by=updated_at&sort=desc`,
            "GET",
            {},
            signal,
          ),
        );
      return r.map((x) => normalizeItem(x, repo, kind));
    },
    async detail(s: Selection, signal?: AbortSignal) {
      const raw = await api(s.repo, endpoint(s), "GET", {}, signal);
      const item = normalizeItem(raw, s.repo, s.kind);
      const notes = z
        .array(
          z.object({
            id: z.number(),
            author: z.object({ username: z.string() }),
            body: z.string(),
            created_at: z.string(),
            system: z.boolean(),
          }),
        )
        .parse(
          await api(
            s.repo,
            `${endpoint(s)}/notes?per_page=100&sort=desc`,
            "GET",
            {},
            signal,
          ),
        )
        .map((n) =>
          noteSchema.parse({
            id: n.id,
            author: n.author.username,
            body: n.body.slice(0, 20000),
            createdAt: n.created_at,
            system: n.system,
          }),
        );
      return { item, notes };
    },
    async comment(s: Selection, body: string, signal?: AbortSignal) {
      await api(s.repo, `${endpoint(s)}/notes`, "POST", { body }, signal);
    },
    async create(
      repo: string,
      title: string,
      description: string,
      signal?: AbortSignal,
    ) {
      return normalizeItem(
        await api(repo, "/issues", "POST", { title, description }, signal),
        repo,
        "issue",
      );
    },
    async update(
      s: Selection,
      fields: Record<string, string | number[]>,
      signal?: AbortSignal,
    ) {
      return normalizeItem(
        await api(s.repo, endpoint(s), "PUT", fields, signal),
        s.repo,
        s.kind,
      );
    },
    async users(repo: string, signal?: AbortSignal) {
      return z
        .array(
          z.object({
            id: z.number().int().positive(),
            username: z.string(),
            name: z.string(),
          }),
        )
        .parse(await api(repo, "/members/all?per_page=100", "GET", {}, signal));
    },
  };
}
export type Gitlab = ReturnType<typeof createGitlab>;
