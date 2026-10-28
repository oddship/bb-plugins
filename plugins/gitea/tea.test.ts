import { test } from "node:test";
import assert from "node:assert/strict";
import { createTea, normalizeItem, safeUrl, runTea } from "./tea.js";
import { detail, listing, slug } from "./contract.js";
const raw = {
  number: 7,
  title: "A fix",
  body: null,
  html_url: "https://git.example/a/b/pulls/7",
  state: "open",
  user: { login: "alice" },
  labels: [{ name: "bug" }],
  head: { ref: "fix" },
  base: { ref: "main" },
};
test("normalizes Gitea PRs and bounds remote text", () => {
  assert.deepEqual(normalizeItem(raw), {
    number: 7,
    title: "A fix",
    body: "",
    url: raw.html_url,
    state: "open",
    author: "alice",
    updatedAt: "",
    labels: ["bug"],
    head: "fix",
    base: "main",
    merged: false,
  });
  assert.equal(
    normalizeItem({ ...raw, body: "x".repeat(30000) }).body.length,
    24000,
  );
});
test("rejects invalid slugs, traversal, item IDs and pages", () => {
  for (const value of [
    "../repo",
    "owner/..",
    "https://evil/repo",
    "a/b/c",
    "-x",
    "a/b?token=x",
  ])
    assert.equal(slug.safeParse(value).success, false, value);
  assert.equal(slug.parse("owner/repo.name"), "owner/repo.name");
  assert.equal(
    detail.safeParse({ login: "work", repo: "a/b", kind: "pulls", number: 0 })
      .success,
    false,
  );
  for (const page of [0, -1, 1.5, Infinity])
    assert.equal(
      listing.safeParse({ login: "work", repo: "a/b", kind: "issues", page })
        .success,
      false,
    );
});
test("allows HTTP(S) links only and refuses embedded credentials", () => {
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,test",
    "file:///tmp/a",
    "https://secret:token@host/a",
    null,
  ])
    assert.equal(safeUrl(value), "");
  assert.equal(safeUrl("https://git.example/a"), "https://git.example/a");
});
test("uses fixed GET endpoints and argument arrays; excludes PRs from issues", async () => {
  const calls: string[][] = [];
  const tea = createTea(async (args) => {
    calls.push(args);
    return [raw, { ...raw, number: 8, pull_request: { url: "x" } }];
  });
  const result = await tea.items(
    "work;touch /tmp/no",
    "a/b",
    "issues",
    "open",
    2,
  );
  assert.equal(result.length, 1);
  assert.deepEqual(calls, [
    [
      "api",
      "--login",
      "work;touch /tmp/no",
      "--method",
      "GET",
      "repos/a/b/issues?state=open&sort=updated&limit=30&page=2&type=issues",
    ],
  ]);
});
test("maps repo metadata, logins and comments without forwarding tokens", async () => {
  const tea = createTea(async (args) => {
    if (args[0] === "login")
      return [
        {
          name: "work",
          url: "https://git.example",
          user: "alice",
          token: "DO_NOT_EXPOSE",
        },
      ];
    if (args.at(-1)?.includes("user/repos"))
      return [
        {
          full_name: "a/b",
          html_url: "https://git.example/a/b",
          description: null,
        },
      ];
    if (args.at(-1)?.includes("/comments"))
      return [{ user: null, body: "hello", html_url: "javascript:alert(1)" }];
    return raw;
  });
  assert.deepEqual(await tea.logins(), [
    { name: "work", url: "https://git.example/", user: "alice" },
  ]);
  assert.equal((await tea.repos("work", 1))[0]!.description, "");
  assert.deepEqual((await tea.detail("work", "a/b", "pulls", 7)).comments, [
    { author: "", body: "hello", url: "" },
  ]);
});
test("does not interpret API error objects as empty results", async () => {
  const tea = createTea(async () => ({ message: "permission denied" }));
  await assert.rejects(tea.items("work", "a/b", "pulls", "open", 1));
});
test("subprocess cancellation stops tea promptly", async () => {
  const c = new AbortController();
  c.abort();
  await assert.rejects(
    runTea(["login", "list", "--output", "json"], c.signal),
    /tea request failed/,
  );
});
