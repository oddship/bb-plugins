import { expect, it, vi } from "vitest";
import { argumentsFor, normalize, readLogchef, runLogchef } from "../logchef";
import { requestSchema } from "../contract";
const query = requestSchema.parse({
  action: "query",
  team: "1",
  source: "2",
  context: "prod",
  query: 'level="error"',
});
it("passes filters literally after the option terminator", () => {
  const text = "--server https://evil.invalid; $(touch /tmp/never)";
  const args = argumentsFor({ ...query, query: text } as typeof query);
  expect(args.slice(-2)).toEqual(["--", text]);
  expect(args).toEqual([
    "--context",
    "prod",
    "query",
    "--output",
    "json",
    "--team",
    "1",
    "--source",
    "2",
    "--limit",
    "100",
    "--since",
    "15m",
    "--",
    text,
  ]);
});
it("rejects options in selectors, unknown actions and unbounded queries", () => {
  for (const change of [
    { team: "--token" },
    { context: "-x" },
    { limit: 501 },
    { limit: 0 },
    { query: "x".repeat(12001) },
    { since: "forever" },
    { query: "a\0b" },
  ])
    expect(requestSchema.safeParse({ ...query, ...change }).success).toBe(
      false,
    );
  expect(requestSchema.safeParse({ action: "auth" }).success).toBe(false);
  expect(
    requestSchema.safeParse({ action: "teams", token: "secret" }).success,
  ).toBe(false);
});
it("requires an ordered pair of absolute timestamps and omits relative flags", () => {
  expect(
    requestSchema.safeParse({ ...query, from: "2026-11-19T00:00:00Z" }).success,
  ).toBe(false);
  expect(
    requestSchema.safeParse({
      ...query,
      from: "2026-11-19T01:00:00Z",
      to: "2026-11-19T00:00:00Z",
    }).success,
  ).toBe(false);
  const absolute = requestSchema.parse({
    ...query,
    from: "2026-11-19T00:00:00Z",
    to: "2026-11-19T01:00:00Z",
  });
  expect(argumentsFor(absolute)).not.toContain("--since");
});
it("normalizes discovery without leaking arbitrary CLI fields", () => {
  expect(
    normalize("sources", [
      {
        id: 12,
        name: "API",
        source_type: "clickhouse",
        target: "logs.api",
        token: "secret",
        connection: { password: "secret" },
      },
    ]).rows,
  ).toEqual([{ id: "12", name: "API", detail: "clickhouse · logs.api" }]);
  expect(
    normalize("schema", [{ name: "level", type: "String" }]).rows[0].detail,
  ).toBe("String");
});
it("bounds Unicode query output and marks dropped rows", () => {
  const result = normalize("query", {
    logs: Array.from({ length: 501 }, () => ({ msg: "界".repeat(4000) })),
    stats: {},
  });
  expect(result.truncated).toBe(true);
  expect(result.count).toBe(result.logs.length);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
    480 * 1024,
  );
});
it("rejects malformed query responses rather than returning an empty success", () => {
  expect(() => normalize("query", { error: "denied" })).toThrow();
});
it("propagates cancellation and keeps binary selection out of user args", async () => {
  const signal = new AbortController().signal;
  const run = vi.fn(async () => []);
  await readLogchef({ action: "teams" }, "/opt/logchef", signal, run);
  expect(run).toHaveBeenCalledWith(
    "/opt/logchef",
    ["teams", "--output", "json"],
    signal,
  );
});
it("reports a missing executable without exposing process environment", async () => {
  await expect(
    runLogchef("/definitely/missing/logchef", ["teams"]),
  ).rejects.toThrow("was not found");
});
