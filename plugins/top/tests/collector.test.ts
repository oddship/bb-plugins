import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Collector,
  attribute,
  group,
  hasOmittedDetails,
  measure,
  parseStat,
  threadFromEnvironment,
  sessionFromLock,
  ownerFromSessions,
  type RawProcess,
} from "../lib/collector";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import entry from "../host";
const id = "thr_test123456";
const sessionId = "01a1e382-2ee8-7df1-bfd4-e012565c6e40";

it("matches exact Codex writer-lock IDs and refuses shared-session ambiguity", () => {
  expect(
    sessionFromLock(`/tmp/codex/thread-writer-locks/${sessionId}.lock`),
  ).toBe(sessionId);
  expect(sessionFromLock(`/tmp/${sessionId}.lock`)).toBeNull();
  expect(ownerFromSessions([sessionId], [{ threadId: id, sessionId }])).toBe(
    id,
  );
  expect(
    ownerFromSessions(
      [sessionId],
      [
        { threadId: id, sessionId },
        { threadId: "thr_other12345", sessionId },
      ],
    ),
  ).toBeNull();
});

it("attributes an untagged persistent Codex process through its session writer lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bb-top-session-"));
  await mkdir(join(dir, "thread-writer-locks"));
  const path = join(dir, "thread-writer-locks", `${sessionId}.lock`);
  const env = { ...process.env };
  delete env.BB_THREAD_ID;
  const child = spawn(
    process.execPath,
    [
      "-e",
      'process.title="codex"; require("fs").openSync(process.argv[1],"w"); console.log("ready"); setInterval(()=>{},1000)',
      path,
    ],
    { env, stdio: ["ignore", "pipe", "ignore"] },
  );
  const collector = new Collector();
  try {
    await once(child.stdout!, "data");
    const sample = await collector.sample([{ threadId: id, sessionId }]);
    expect(
      sample.threads
        .find((t) => t.id === id)
        ?.processes.some((p) => p.pid === child.pid),
    ).toBe(true);
  } finally {
    collector.dispose();
    child.kill();
    await once(child, "exit");
    await rm(dir, { recursive: true, force: true });
  }
}, 10000);
const row = (
  pid: number,
  ppid: number,
  thread: string | null = null,
): RawProcess => ({
  pid,
  ppid,
  thread,
  name: "node",
  ticks: 100,
  start: "1000",
  cpu: 0,
  rss: 4096,
});

describe("process attribution and accounting", () => {
  it("extracts only a valid exact environment key", () => {
    expect(
      threadFromEnvironment(
        Buffer.from(`TOKEN=secret\0BB_THREAD_ID=${id}\0PWD=/tmp`),
      ),
    ).toBe(id);
    expect(
      threadFromEnvironment(Buffer.from(`NOT_BB_THREAD_ID=${id}\0`)),
    ).toBeNull();
    expect(
      threadFromEnvironment(Buffer.from("BB_THREAD_ID=invalid\0")),
    ).toBeNull();
  });
  it("handles spaces and closing parentheses in Linux process names", () => {
    const fields = Array(22).fill("0");
    fields[0] = "S";
    fields[1] = "12";
    fields[11] = "40";
    fields[12] = "10";
    fields[19] = "200";
    fields[21] = "4";
    expect(
      parseStat(`50 (node ) worker) ${fields.join(" ")}`, 4096),
    ).toMatchObject({
      pid: 50,
      ppid: 12,
      name: "node ) worker",
      ticks: 50,
      start: "200",
      rss: 16384,
    });
    expect(parseStat("not a stat", 4096)).toBeNull();
  });
  it("inherits nearest explicit ownership without double counting", () => {
    const other = "thr_other123456";
    const rows = [
      row(40, 30),
      row(30, 20),
      row(20, 1, id),
      row(50, 30, other),
      row(60, 99),
    ];
    expect([...attribute(rows).entries()]).toEqual(
      expect.arrayContaining([
        [40, id],
        [30, id],
        [50, other],
        [60, null],
      ]),
    );
    expect(group(rows).find((r) => r.id === id)).toMatchObject({
      count: 3,
      rss: 12288,
    });
  });
  it("terminates ancestry cycles and gives explicit child ownership priority", () => {
    const rows = [row(2, 3), row(3, 2), row(4, 2, id)];
    expect(attribute(rows).get(2)).toBeNull();
    expect(attribute(rows).get(4)).toBe(id);
  });
  it("measures recent CPU and rejects recycled PIDs and counter resets", () => {
    const old = row(20, 1, id);
    const now = { ...old, ticks: 400 };
    measure([now], new Map([[20, old]]), 2000, 100);
    expect(now.cpu).toBe(150);
    now.start = "2000";
    measure([now], new Map([[20, old]]), 2000, 100);
    expect(now.cpu).toBe(0);
    now.start = old.start;
    now.ticks = 0;
    measure([now], new Map([[20, old]]), 2000, 100);
    expect(now.cpu).toBe(0);
  });
  it("bounds process details while preserving thread totals", () => {
    const rows = Array.from({ length: 220 }, (_, i) => row(100 + i, 1, id));
    expect(group(rows)[0]).toMatchObject({ count: 220, rss: 220 * 4096 });
    expect(group(rows)[0].processes).toHaveLength(100);
    expect(hasOmittedDetails(group(rows))).toBe(true);
    expect(hasOmittedDetails(group(rows.slice(0, 3)))).toBe(false);
  });
});

it("reads a real tagged process, shares in-flight calls, and samples CPU deltas", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "const b=Buffer.alloc(32*1024*1024,1); setInterval(()=>{const t=Date.now();while(Date.now()-t<15){}; b[0]++},100)",
    ],
    { env: { ...process.env, BB_THREAD_ID: id }, stdio: "ignore" },
  );
  const collector = new Collector();
  try {
    await once(child, "spawn");
    await delay(150);
    const pending = collector.sample();
    expect(collector.sample()).toBe(pending);
    const first = await pending;
    expect(first.intervalMs).toBe(0);
    expect(
      first.threads
        .find((r) => r.id === id)
        ?.processes.some((p) => p.pid === child.pid),
    ).toBe(true);
    expect(JSON.stringify(first)).not.toContain("TOKEN=");
    expect(await collector.sample()).toBe(first);
    await delay(2100);
    const next = await collector.sample();
    expect(next.at).toBeGreaterThan(first.at);
    expect(next.threads.find((r) => r.id === id)!.cpu).toBeGreaterThan(0);
    expect(next.threads.find((r) => r.id === id)!.rss).toBeGreaterThan(
      30 * 1048576,
    );
    collector.dispose();
    await expect(collector.sample()).rejects.toThrow("disposed");
  } finally {
    collector.dispose();
    child.kill();
    await once(child, "exit");
  }
}, 10000);

it("validates the host wire contract and disposes its collector", async () => {
  const harness = experimental_createHostEntryHarness(entry);
  const sample = await harness.experimental_call("sample", {});
  expect(sample.scanned).toBeGreaterThan(0);
  await expect(
    harness.experimental_call("sample", { arbitrary: true } as never),
  ).rejects.toThrow();
  await harness.experimental_dispose();
});

it("uses only public SDK imports", async () => {
  const result = await experimental_scanPublicSdkOnly(process.cwd(), {
    allow: [
      /^react(?:-dom)?$/,
      /^@radix-ui\/react-slot$/,
      /^class-variance-authority$/,
      /^clsx$/,
      /^tailwind-merge$/,
      /^@testing-library\/react$/,
    ],
  });
  expect(result.violations).toEqual([]);
  expect(result.privateDependencies).toEqual([]);
});
