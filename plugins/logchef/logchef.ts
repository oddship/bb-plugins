import { execFile } from "node:child_process";
import { z } from "zod";
import { requestSchema, type Request, type Result } from "./contract";
export type Run = (
  binary: string,
  args: string[],
  signal?: AbortSignal,
) => Promise<unknown>;
export function argumentsFor(value: Request): string[] {
  const i = requestSchema.parse(value);
  const args = i.context ? ["--context", i.context] : [];
  args.push(i.action, "--output", "json");
  if ("team" in i) args.push("--team", i.team);
  if ("source" in i) args.push("--source", i.source);
  if (i.action === "query") {
    args.push("--limit", String(i.limit));
    if (i.from && i.to) args.push("--from", i.from, "--to", i.to);
    else args.push("--since", i.since);
    args.push("--", i.query);
  }
  return args;
}
export const runLogchef: Run = (binary, args, signal) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      binary,
      args,
      {
        signal,
        timeout: 45000,
        maxBuffer: 768 * 1024,
        env: { ...process.env, NO_COLOR: "1", CLICOLOR: "0" },
      },
      (error, stdout) => {
        if (error)
          return reject(
            new Error(
              (error as NodeJS.ErrnoException).code === "ENOENT"
                ? "LogChef CLI was not found on the selected machine. Install it or set the plugin's binaryPath."
                : "LogChef request failed, timed out, or exceeded 768 KiB. Check CLI authentication and network access on the selected machine, or narrow the query. Run logchef teams --output json there to diagnose.",
            ),
          );
        // Upstream prints plain text for empty lists even with JSON selected.
        if (
          /^No (teams|sources|collections|columns)( available| found)?\.?\s*$/i.test(
            stdout.trim(),
          )
        )
          return resolve([]);
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(
            new Error(
              "LogChef returned invalid JSON. Check the installed CLI version.",
            ),
          );
        }
      },
    );
    child.stdin?.end();
  });
const rawRow = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  name: z.string(),
  description: z.string().nullish(),
  type: z.string().optional(),
  source_type: z.string().optional(),
  target: z.string().nullish(),
  query_type: z.string().optional(),
});
export function normalize(action: Request["action"], raw: unknown): Result {
  const result: Result = {
    rows: [],
    logs: [],
    count: 0,
    stats: {},
    generatedSql: "",
    truncated: false,
  };
  if (action !== "query") {
    const rows = z.array(rawRow).parse(raw);
    result.rows = rows
      .slice(0, 1000)
      .map((r, index) => ({
        id: String(r.id ?? index),
        name: r.name.slice(0, 500),
        detail: [
          r.type ?? r.source_type ?? r.query_type,
          r.target,
          r.description,
        ]
          .filter(Boolean)
          .join(" · ")
          .slice(0, 1000),
      }));
    result.count = result.rows.length;
    result.truncated = rows.length > 1000;
  } else {
    const parsed = z
      .object({
        logs: z.array(z.record(z.string(), z.unknown())),
        stats: z.record(z.string(), z.unknown()).nullish(),
        generated_sql: z.string().nullish(),
      })
      .parse(raw);
    result.stats = parsed.stats ?? {};
    result.generatedSql = (parsed.generated_sql ?? "").slice(0, 12000);
    let bytes = Buffer.byteLength(JSON.stringify(result)) + 128;
    for (const row of parsed.logs) {
      const size = Buffer.byteLength(JSON.stringify(row)) + 1;
      if (result.logs.length >= 500 || bytes + size > 480 * 1024) {
        result.truncated = true;
        break;
      }
      result.logs.push(row);
      bytes += size;
    }
    result.count = result.logs.length;
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 480 * 1024)
    throw new Error(
      "LogChef response is too large. Narrow the source or query.",
    );
  return result;
}
export async function readLogchef(
  request: Request,
  binary: string,
  signal?: AbortSignal,
  run: Run = runLogchef,
): Promise<Result> {
  return normalize(
    request.action,
    await run(binary, argumentsFor(request), signal),
  );
}
