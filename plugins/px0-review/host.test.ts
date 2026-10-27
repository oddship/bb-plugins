import { it, expect } from "vitest";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import host from "./host";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const executable = process.env.PX0_TEST_BINARY;
it.skipIf(!executable)(
  "launches the fork, authenticates all routes, and cleans up its process",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "bb-px0-test-"));
    const dataDir = await mkdtemp(join(tmpdir(), "bb-px0-data-"));
    await writeFile(join(root, "hello.ts"), "export const answer = 42;\n");
    const h = experimental_createHostEntryHarness(host, {
      experimental_paths: { dataDir, tempDir: dataDir },
    });
    try {
      const session = await h.experimental_call("ensure", {
        key: "test",
        threadId: "thr_test",
        root,
        origin: "http://localhost:9999",
        tunnel: null,
        binaryPath: executable!,
      });
      expect((await fetch(new URL("/api/meta", session.url))).status).toBe(401);
      const token = new URL(session.url).searchParams.get("px0_token")!;
      const response = await fetch(new URL("/api/meta", session.url), {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-security-policy")).toContain(
        "frame-ancestors http://localhost:9999",
      );
      expect((await response.json()).root).toBe(root);
      const second = await h.experimental_call("ensure", {
        key: "test",
        threadId: "thr_test",
        root,
        origin: "http://localhost:9999",
        tunnel: null,
        binaryPath: executable!,
      });
      expect(second.pid).toBe(session.pid);
      expect(second.fileCount).toBe(1);
      await rm(join(root, "hello.ts"));
      const refresh = await fetch(new URL("/api/reindex", session.url), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: new URL(session.url).origin,
        },
      });
      expect(refresh.status).toBe(200);
      const empty = await h.experimental_call("ensure", {
        key: "test",
        threadId: "thr_test",
        root,
        origin: "http://localhost:9999",
        tunnel: null,
        binaryPath: executable!,
      });
      expect(empty.fileCount).toBe(0);
      await h.experimental_call("stop", { threadId: "thr_test" });
      expect((await h.experimental_call("status", null)).sessions).toEqual([]);
      await expect(fetch(new URL("/api/meta", session.url))).rejects.toThrow();
    } finally {
      await h.experimental_dispose();
      await rm(root, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    }
  },
  30000,
);
