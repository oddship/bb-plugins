import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  requestSchema,
  overviewSchema,
  postSchema,
  channelSchema,
  type Request,
} from "./contract";
export function commandArgs(raw: unknown): string[] {
  const r = requestSchema.parse(raw);
  switch (r.kind) {
    case "overview":
      return ["overview", "--since", r.since];
    case "mentions":
      return ["mentions", "--since", r.since, "--limit", "100"];
    case "search":
      return ["search", r.query, "--limit", "50"];
    case "channels":
      return ["channels"];
    case "unread":
      return ["unread"];
    case "messages":
      return ["messages", r.target, "--limit", "100"];
    case "thread":
      return ["thread", r.target, "--limit", String(r.limit ?? 100)];
  }
}
export async function readMm(request: Request, signal: AbortSignal) {
  const local = join(homedir(), ".local", "bin", "mm");
  const executable = await access(local).then(
    () => local,
    () => "mm",
  );
  const args = commandArgs(request);
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      executable,
      args,
      { signal, timeout: 25000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (error, stdout) => {
        // Do not forward raw stderr, which may contain private session details.
        if (error)
          reject(
            new Error(
              "mm request failed. Check that the host is online, mm is installed, and mm whoami succeeds. Requests time out after 25 seconds.",
            ),
          );
        else resolve(stdout);
      },
    );
  });
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new Error("mm returned invalid JSON. Update mm and retry.");
  }
  const schema =
    request.kind === "overview"
      ? overviewSchema
      : request.kind === "channels" || request.kind === "unread"
        ? z.array(channelSchema)
        : z.array(postSchema);
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      "Unexpected mm response format. Update mm or the Mattermost plugin.",
    );
  return { fetchedAt: new Date().toISOString(), data: parsed.data };
}
