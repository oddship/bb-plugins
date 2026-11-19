import { describe, it, expect } from "vitest";
import {
  createFakePluginHost,
  makeHostResponse,
} from "@get-bb/plugin-sdk/testing";
import { makePlugin } from "../server";

describe("execution machine routing", () => {
  it("routes status, sync and writes through the chosen host, clearing cache on switch", async () => {
    const calls: {
      hostId: string;
      input: { args: string[]; input?: string };
    }[] = [];
    const raw = {
      iid: 7,
      title: "Example",
      description: "",
      web_url: "https://gitlab.example.com/team/project/-/issues/7",
      state: "opened",
      author: { username: "alex" },
      assignees: [],
      labels: [],
      updated_at: "2026-11-11T00:00:00Z",
    };
    const { bb, harness } = createFakePluginHost({
      pluginId: "oddship-gitlab",
      settings: {
        hostId: "host_work",
        hostname: "gitlab.example.com",
        extraRepos: "team/project",
      },
      sdk: {
        projects: { list: async () => [] },
        hosts: {
          list: async () => [
            makeHostResponse({ id: "host_work", name: "Work laptop" }),
            makeHostResponse({ id: "host_public", name: "Public machine" }),
          ],
        },
      },
      experimental_callHostRpc: async ({ hostId, input }) => {
        const request = input as { args: string[]; input?: string };
        calls.push({ hostId, input: request });
        if (request.args.at(-1) === "user")
          return JSON.stringify({ username: "alex" });
        if (request.args.includes("POST")) return JSON.stringify(raw);
        return JSON.stringify(
          request.args.some((s) => s.includes("issues")) ? [raw] : [],
        );
      },
    });
    await makePlugin()(bb);
    try {
      expect((await harness.behavior.callRpc("status", null)).username).toBe(
        "alex",
      );
      await harness.behavior.callRpc("sync", null);
      expect(
        (await harness.behavior.callRpc("list", { kind: "issue" })).total,
      ).toBe(1);
      await harness.behavior.callRpc("createIssue", {
        repo: "gitlab.example.com/team/project",
        title: "$(literal)",
        body: "test",
      });
      expect(calls.every((c) => c.hostId === "host_work")).toBe(true);
      expect(calls.some((c) => c.input.input?.includes("$(literal)"))).toBe(
        true,
      );
      await harness.behavior.callRpc("selectMachine", {
        hostId: "host_public",
      });
      expect(
        (await harness.behavior.callRpc("list", { kind: "issue" })).total,
      ).toBe(0);
      await harness.behavior.callRpc("status", null);
      expect(calls.at(-1)?.hostId).toBe("host_public");
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("reports a disconnected selected machine without running on another host", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "oddship-gitlab",
      settings: { hostId: "host_work" },
      experimental_callHostRpc: async ({ hostId }) => {
        expect(hostId).toBe("host_work");
        throw Error("selected host disconnected");
      },
    });
    await makePlugin()(bb);
    try {
      expect((await harness.behavior.callRpc("status", null)).error).toContain(
        "disconnected",
      );
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});
