import { describe, it, expect } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { originSchema, selectionSchema } from "./contract";
const selection = {
  path: "src/index.ts",
  l1: 2,
  l2: 4,
  text: "const answer = 42;",
};
function setup() {
  const sends: unknown[] = [];
  const thread = makeThreadResponse({
    id: "thr_test",
    environmentId: "env_test",
  });
  const env = {
    id: "env_test",
    hostId: "host_test",
    path: "/workspace/project",
    hostLifecycle: "active",
  };
  const { bb, harness } = createFakePluginHost({
    pluginId: "px0-review",
    sdk: {
      threads: {
        get: async () => thread,
        send: async (input) => {
          sends.push(input);
          return {} as never;
        },
      },
      environments: { get: async () => env as never },
    },
  });
  plugin(bb);
  return { harness, sends, thread, env };
}
describe("review feedback", () => {
  it("sends to the original BB thread, queues while active, and keeps provider settings", async () => {
    const { harness, sends } = setup();
    await harness.behavior.callRpc("feedback", {
      threadId: "thr_test",
      environmentId: "env_test",
      requestId: crypto.randomUUID(),
      selection,
      instruction: "Handle null values",
    });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      threadId: "thr_test",
      mode: "queue-if-active",
    });
    expect(sends[0]).not.toHaveProperty("model");
    expect(sends[0]).not.toHaveProperty("permissionMode");
    expect(JSON.stringify(sends[0])).toContain("src/index.ts");
    await harness.lifecycle.dispose();
  });
  it("deduplicates repeated feedback submissions", async () => {
    const { harness, sends } = setup();
    const input = {
      threadId: "thr_test",
      environmentId: "env_test",
      requestId: crypto.randomUUID(),
      selection,
      instruction: "Handle null",
    };
    await Promise.all([
      harness.behavior.callRpc("feedback", input),
      harness.behavior.callRpc("feedback", input),
    ]);
    expect(sends).toHaveLength(1);
    await harness.lifecycle.dispose();
  });
  it("refuses feedback from a previous worktree", async () => {
    const { harness, sends } = setup();
    await expect(
      harness.behavior.callRpc("feedback", {
        threadId: "thr_test",
        environmentId: "env_old",
        requestId: crypto.randomUUID(),
        selection,
        instruction: "Handle null",
      }),
    ).rejects.toThrow(/workspace changed/);
    expect(sends).toHaveLength(0);
    await harness.lifecycle.dispose();
  });
  it("refuses feedback for archived threads", async () => {
    const { harness, sends, thread } = setup();
    thread.archivedAt = 1;
    await expect(
      harness.behavior.callRpc("feedback", {
        threadId: "thr_test",
        environmentId: "env_test",
        requestId: crypto.randomUUID(),
        selection,
        instruction: "Handle null",
      }),
    ).rejects.toThrow(/archived/);
    expect(sends).toHaveLength(0);
    await harness.lifecycle.dispose();
  });
});
describe("input boundaries", () => {
  it("accepts only exact HTTP origins", () => {
    expect(originSchema.safeParse("https://rhnvrm.getbb.app").success).toBe(
      true,
    );
    for (const origin of [
      "*",
      "javascript:alert(1)",
      "https://bb.example/",
      "https://bb.example/path",
      "https://user@bb.example",
      "https://bb.example;script-src *",
    ])
      expect(originSchema.safeParse(origin).success).toBe(false);
  });
  it("rejects traversal, absolute paths, reversed ranges and oversized selections", () => {
    for (const s of [
      { ...selection, path: "../secret" },
      { ...selection, path: "/etc/passwd" },
      { ...selection, l2: 1 },
      { ...selection, text: "x".repeat(24001) },
    ])
      expect(selectionSchema.safeParse(s).success).toBe(false);
  });
});

describe("remote primary-host sharing", () => {
  it("uses BB Connect for the primary host and removes its shares on stop", async () => {
    const calls: string[] = [];
    let sessions: any[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "px0-review",
      sdk: {
        threads: {
          get: async () =>
            makeThreadResponse({ id: "thr_test", environmentId: "env_test" }),
        },
        environments: {
          get: async () =>
            ({
              id: "env_test",
              hostId: "primary",
              path: "/workspace",
              hostLifecycle: "active",
            }) as never,
        },
        system: { config: async () => ({ primaryHostId: "primary" }) as never },
        plugins: {
          callRpc: async (args) => {
            calls.push(args.method);
            if (args.method === "status")
              return {
                paired: true,
                enabled: true,
                url: "https://owner.getbb.app",
              } as never;
            if (args.method === "expose")
              return { url: "https://owner--12345.getbb.app" } as never;
            return { removed: true } as never;
          },
        },
      },
      experimental_callHostRpc: async ({ method, input }) => {
        if (method === "ensure") {
          const x = input as any;
          const session = {
            key: x.key,
            threadId: x.threadId,
            root: x.root,
            port: 12345,
            pid: 100,
            lastUsed: Date.now(),
            url: "https://owner--12345.getbb.app/?px0_token=test",
          };
          sessions = [session];
          return session;
        }
        if (method === "stop") {
          sessions = [];
          return { stopped: 1 };
        }
        return { sessions };
      },
    });
    plugin(bb);
    const result = await harness.behavior.callRpc("open", {
      threadId: "thr_test",
      origin: "https://owner.getbb.app",
      remote: true,
    });
    expect(result).toMatchObject({
      hostId: "primary",
      environmentId: "env_test",
    });
    expect(calls).toContain("expose");
    await harness.behavior.callRpc("stop", { threadId: "thr_test" });
    expect(calls).toContain("unexpose");
    await harness.lifecycle.dispose();
  });
});
