import test from "node:test";
import assert from "node:assert/strict";
import { Api, ApiError } from "./api.js";
test("catalog reads the current control API items envelope and strips unrelated fields", async () => {
  class Catalog extends Api {
    override async request() {
      return {
        items: [{ id: "host", hostname: "local", private: "excluded" }],
      };
    }
  }
  assert.deepEqual(
    await new Catalog("http://localhost:1323", "test").choices(
      "hosts",
      AbortSignal.timeout(1000),
    ),
    [{ id: "host", hostname: "local" }],
  );
});

test("quota rejections identify exhausted resources without changing HTTP status", async () => {
  const original = globalThis.fetch;
  const messages = [
    [
      "this would use 6 vCPU of your 4 limit; you are already using 4",
      /vCPU quota exceeded: already using 4 of 4; this request would use 6/,
    ],
    [
      "this would use 4864 MiB of memory against your 4096 MiB limit; you are already using 2816 MiB",
      /memory MiB quota exceeded/,
    ],
    [
      "this would use 14336 MiB of disk against your 10240 MiB limit; you are already using 10240 MiB",
      /disk MiB quota exceeded/,
    ],
  ] as const;
  try {
    for (const [message, expected] of messages) {
      globalThis.fetch = async () =>
        Response.json({ message }, { status: 403 });
      await assert.rejects(
        new Api("http://localhost:1323", "test").request(
          "/vms",
          AbortSignal.timeout(1000),
          "POST",
          {},
        ),
        (e: unknown) =>
          e instanceof ApiError && e.status === 403 && expected.test(e.message),
      );
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("unrecognized, malformed and oversized errors do not disclose response contents", async () => {
  const original = globalThis.fetch;
  try {
    for (const body of [
      JSON.stringify({ message: "private diagnostic test-marker" }),
      "<html>private diagnostic test-marker</html>",
      JSON.stringify({
        message:
          "this would use 6 vCPU of your 4 limit; you are already using 4",
        other: "test-marker".repeat(1000),
      }),
    ]) {
      globalThis.fetch = async () => new Response(body, { status: 403 });
      await assert.rejects(
        new Api("http://localhost:1323", "test").request(
          "/vms",
          AbortSignal.timeout(1000),
        ),
        (e: unknown) =>
          e instanceof ApiError &&
          e.status === 403 &&
          !e.message.includes("test-marker") &&
          !e.message.includes("quota exceeded"),
      );
    }
  } finally {
    globalThis.fetch = original;
  }
});
