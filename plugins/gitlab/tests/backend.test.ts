import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  experimental_scanPublicSdkOnly,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { makePlugin } from "../server";
import { createGitlab, createRunner } from "../glab";
import {
  normalizeItem,
  parseRepo,
  parseExtras,
  remoteRepo,
  type Item,
} from "../model";

const repo = "gitlab.example.com/team/nested/project";
const raw = {
  iid: 7,
  title: "Fix ordering",
  description: "Repro steps",
  web_url: "https://gitlab.example.com/team/nested/project/-/issues/7",
  state: "opened",
  author: { username: "alex" },
  assignees: [],
  labels: ["bug"],
  updated_at: "2026-10-28T00:00:00Z",
};
const item = normalizeItem(raw, repo, "issue");
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function setup(extra = {}) {
  const gitlab = {
    status: vi.fn(async (host: string) => ({ host, username: "alex" })),
    items: vi.fn(async (r: string, k: Item["kind"], s: string) =>
      s === "opened" ? [{ ...item, repo: r, kind: k }] : [],
    ),
    detail: vi.fn(async () => ({ item, notes: [] })),
    comment: vi.fn(async () => {}),
    create: vi.fn(async () => item),
    update: vi.fn(async () => item),
    users: vi.fn(async () => []),
  };
  const { bb, harness } = createFakePluginHost({
    pluginId: "oddship-gitlab",
    settings: {
      hostname: "gitlab.example.com",
      extraRepos: "team/nested/project",
    },
    sdk: {
      projects: { list: async () => [] },
      threads: {
        spawn: async () => makeThreadResponse({ id: "thread-created" }),
      },
    },
    ...extra,
  });
  await makePlugin(gitlab)(bb);
  cleanup.push(() => harness.lifecycle.dispose());
  return { harness, gitlab };
}
describe("repository identity", () => {
  it("handles nested paths, HTTPS, SCP and SSH remotes", () => {
    expect(parseRepo("team/nested/project", "gitlab.example.com")).toBe(repo);
    expect(
      parseRepo(
        "https://gitlab.example.com/team/nested/project.git",
        "unused.test",
      ),
    ).toBe(repo);
    expect(
      parseRepo(
        "git@gitlab.example.com:team/nested/project.git",
        "unused.test",
      ),
    ).toBe(repo);
    expect(
      parseRepo(
        "ssh://git@gitlab.example.com/team/nested/project.git",
        "unused.test",
      ),
    ).toBe(repo);
    expect(
      parseExtras(
        "team/nested/project, team/nested/project",
        "gitlab.example.com",
      ),
    ).toEqual([repo]);
  });
  it("rejects credentials, traversal and non-GitLab hosts during discovery", () => {
    for (const r of [
      "https://user:secret@gitlab.example.com/team/p",
      "team/../p",
      "team/$(whoami)",
    ])
      expect(() => parseRepo(r, "gitlab.example.com")).toThrow();
    expect(
      remoteRepo(
        "git@github.com:team/project.git",
        new Set(["gitlab.example.com"]),
      ),
    ).toBe(null);
  });
});
describe("glab wire requests", () => {
  it("encodes project paths, selects the host, and sends write bodies as JSON on stdin", async () => {
    const run = vi.fn(async () => JSON.stringify(raw));
    const api = createGitlab(run);
    await api.update(
      { repo, kind: "issue", number: 7 },
      { assignee_ids: [12, 24] },
    );
    expect(run).toHaveBeenCalledWith(
      [
        "api",
        "--hostname",
        "gitlab.example.com",
        "--method",
        "PUT",
        "projects/team%2Fnested%2Fproject/issues/7",
        "--input",
        "-",
      ],
      undefined,
      JSON.stringify({ assignee_ids: [12, 24] }),
    );
    await api.create(repo, "$(echo nope) @-", "line 1\nline 2");
    expect(JSON.parse(run.mock.calls[1][2]!)).toEqual({
      title: "$(echo nope) @-",
      description: "line 1\nline 2",
    });
  });
  it("uses actual GitLab MR fields and retains draft, reviewers and pipeline", () => {
    expect(
      normalizeItem(
        {
          ...raw,
          draft: true,
          reviewers: [{ username: "reviewer" }],
          source_branch: "fix",
          target_branch: "main",
          head_pipeline: { status: "success" },
        },
        repo,
        "mr",
      ),
    ).toMatchObject({
      draft: true,
      reviewers: ["reviewer"],
      sourceBranch: "fix",
      targetBranch: "main",
      pipeline: "success",
    });
  });
  it("reports a missing executable and honors cancellation", async () => {
    await expect(
      createRunner("/definitely/missing/glab")(["version"]),
    ).rejects.toThrow("not installed");
    const c = new AbortController();
    c.abort();
    await expect(
      createRunner(
        process.execPath,
        c.signal,
      )(["-e", "setTimeout(()=>{},10000)"]),
    ).rejects.toThrow();
  });
});
describe("BB backend contracts", () => {
  it("syncs lists and filters, returning summaries through the CLI", async () => {
    const { harness, gitlab } = await setup();
    expect(await harness.behavior.callRpc("sync")).toEqual({
      repos: 1,
      items: 2,
      errors: [],
    });
    expect(gitlab.items).toHaveBeenCalledTimes(5);
    expect(
      await harness.behavior.callRpc("list", { kind: "issue", query: "bug" }),
    ).toMatchObject({ total: 1, items: [{ number: 7 }] });
    expect(
      await harness.behavior.callRpc("list", {
        kind: "issue",
        state: "closed",
      }),
    ).toMatchObject({ total: 0 });
    const cli = await harness.behavior.runCli(["issues", "--json"]);
    expect(cli.exitCode).toBe(0);
    expect(JSON.parse(cli.stdout).items[0].body).toBeUndefined();
  });
  it("retains the previous cache when one request fails, and surfaces the error", async () => {
    const { harness, gitlab } = await setup();
    await harness.behavior.callRpc("sync");
    gitlab.items.mockRejectedValueOnce(new Error("403 forbidden"));
    expect(await harness.behavior.callRpc("sync")).toMatchObject({
      items: 0,
      errors: [expect.stringContaining("403 forbidden")],
    });
    expect(await harness.behavior.callRpc("list", {})).toMatchObject({
      total: 1,
      errors: [expect.stringContaining("403 forbidden")],
    });
  });
  it("validates mutations and refuses untracked repositories", async () => {
    const { harness, gitlab } = await setup();
    await expect(
      harness.behavior.callRpc("comment", {
        repo,
        kind: "issue",
        number: 7,
        body: " ",
      }),
    ).rejects.toThrow();
    await expect(
      harness.behavior.callRpc("detail", {
        repo: "other.test/team/p",
        kind: "issue",
        number: 7,
      }),
    ).rejects.toThrow("not tracked");
    await expect(
      harness.behavior.callRpc("update", {
        repo,
        kind: "issue",
        number: 7,
        reviewerIds: [2],
      }),
    ).rejects.toThrow("Reviewers");
    await harness.behavior.callRpc("comment", {
      repo,
      kind: "issue",
      number: 7,
      body: "Hello",
    });
    expect(gitlab.comment).toHaveBeenCalledOnce();
    await harness.behavior.callRpc("update", {
      repo,
      kind: "mr",
      number: 7,
      assigneeIds: [],
      reviewerIds: [2],
    });
    expect(gitlab.update).toHaveBeenCalledWith(
      { repo, kind: "mr", number: 7, assigneeIds: [], reviewerIds: [2] },
      { assignee_ids: [], reviewer_ids: [2] },
    );
  });
  it("rejects invalid CLI flags and returns authentication failure as nonzero", async () => {
    const { harness, gitlab } = await setup();
    expect(
      (await harness.behavior.runCli(["issues", "--page", "0", "--json"]))
        .exitCode,
    ).toBe(1);
    expect(
      (await harness.behavior.runCli(["issues", "--nonsense"])).exitCode,
    ).toBe(1);
    gitlab.status.mockRejectedValueOnce(new Error("401 Unauthorized"));
    expect((await harness.behavior.runCli(["status", "--json"])).exitCode).toBe(
      1,
    );
  });
  it("requires a project before spawning and records valid work links", async () => {
    const { harness } = await setup();
    await expect(
      harness.behavior.callRpc("startWork", { repo, kind: "issue", number: 7 }),
    ).rejects.toThrow("Default BB project");
    await harness.behavior.setSettings({ defaultProject: "proj-test" });
    expect(
      await harness.behavior.callRpc("startWork", {
        repo,
        kind: "issue",
        number: 7,
      }),
    ).toEqual({ threadId: "thread-created" });
    const calls = harness.inspection.sdk.callsTo("threads.spawn");
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0])).toContain("glab issue view 7");
    expect(await harness.behavior.callRpc("links")).toMatchObject([
      { threadId: "thread-created", number: 7 },
    ]);
  });
  it("stops its background sync promptly on disposal", async () => {
    const { harness } = await setup();
    const service = harness.behavior.runService("sync");
    await new Promise((r) => setTimeout(r, 20));
    service.controller.abort();
    await service.done;
  });
  it("resolves cached composer mentions through the validated detail reader", async () => {
    const {harness} = await setup();
    await harness.behavior.callRpc('sync');
    const provider = harness.inspection.registrations.mentionProviders.find(p => p.id === 'issue')!;
    const results = await provider.search({query:'ordering',trigger:'@',threadId:null,projectId:null});
    expect(results).toHaveLength(1);
    expect(await provider.resolve(results[0].id)).toMatchObject({context:expect.stringContaining('Repro steps')});
  });
  it("uses only public SDK entrypoints", async () => {
    const scan = await experimental_scanPublicSdkOnly(process.cwd(), {
      allow: [
        /^react(?:-dom)?(?:\/.*)?$/,
        /^@radix-ui\/react-[\w-]+$/,
        /^(?:class-variance-authority|clsx|tailwind-merge|vitest(?:\/.*)?|@testing-library\/react)$/,
      ],
    });
    expect(scan.violations).toEqual([]);
    expect(scan.privateDependencies).toEqual([]);
  });
});
