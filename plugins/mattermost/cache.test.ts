import { expect, test, vi } from "vitest";
import { ReadCache, cacheKey, MAX_AGE } from "./cache";
import { requestSchema, type Snapshot } from "./contract";
const request = requestSchema.parse({ kind: "mentions" });
const deferred = () => {
  let resolve!: (v: Snapshot) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<Snapshot>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
function setup() {
  let now = Date.parse("2026-10-28T12:00:00Z");
  const data = new Map<string, Snapshot>();
  const store = {
    get: (key: string) => data.get(key),
    set: (key: string, value: Snapshot) => {
      data.set(key, value);
    },
  };
  const changed = vi.fn();
  const cache = new ReadCache(store, changed, () => now);
  return {
    cache,
    store,
    data,
    changed,
    advance: (ms: number) => {
      now += ms;
    },
    snapshot: () => ({ fetchedAt: new Date(now).toISOString(), data: [] }),
  };
}
test("cache hit avoids host RPC and survives a new cache instance over persistent store", async () => {
  const s = setup(),
    run = vi.fn(async () => s.snapshot());
  await s.cache.read("host-a", request, run);
  await s.cache.read("host-a", request, run);
  const reloaded = new ReadCache(s.store, s.changed, () =>
    Date.parse("2026-10-28T12:00:01Z"),
  );
  expect((await reloaded.read("host-a", request, run)).cache).toBe("fresh");
  expect(run).toHaveBeenCalledTimes(1);
});
test("stale result returns before refresh and concurrent readers share one call", async () => {
  const s = setup();
  await s.cache.read("host-a", request, async () => s.snapshot());
  await vi.waitFor(() => expect(s.changed).toHaveBeenCalledTimes(1));
  s.advance(61_000);
  const job = deferred(),
    run = vi.fn(() => job.promise);
  const result = await s.cache.read("host-a", request, run);
  expect(result.cache).toBe("stale");
  expect(result.refreshing).toBe(true);
  await s.cache.read("host-a", request, run);
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  job.resolve(s.snapshot());
  await vi.waitFor(() => expect(s.changed).toHaveBeenCalledTimes(2));
  expect((await s.cache.read("host-a", request, run)).cache).toBe("fresh");
});
test("offline refresh retains snapshot, reports staleness and backs off", async () => {
  const s = setup();
  await s.cache.read("host-a", request, async () => s.snapshot());
  await vi.waitFor(() => expect(s.changed).toHaveBeenCalledTimes(1));
  s.advance(61_000);
  const fail = vi.fn(async () => {
    throw new Error("offline");
  });
  const result = await s.cache.read(
    "host-a",
    { ...request, refresh: true },
    fail,
  );
  expect(result.refreshError).toBeTruthy();
  expect(result.cache).toBe("stale");
  await vi.waitFor(() => expect(s.changed).toHaveBeenCalledTimes(2));
  await s.cache.read("host-a", request, fail);
  expect(fail).toHaveBeenCalledTimes(1);
});
test("cache isolates hosts, query periods and discards snapshots older than retention", async () => {
  const s = setup(),
    run = vi.fn(async () => s.snapshot());
  await s.cache.read("host-a", request, run);
  await s.cache.read("host-b", request, run);
  await s.cache.read(
    "host-a",
    requestSchema.parse({ kind: "mentions", since: "7d" }),
    run,
  );
  expect(run).toHaveBeenCalledTimes(3);
  s.advance(MAX_AGE + 1);
  expect(s.cache.peek(cacheKey("host-a", request))).toBeUndefined();
});
test("validation failures reject callers rather than leaving an unresolved flight", async () => {
  const s = setup();
  await expect(
    s.cache.read("host-a", request, async () => ({ nonsense: true }) as any),
  ).rejects.toThrow();
});
test("cold concurrent reads coalesce and forced refresh waits for fresh response", async () => {
  const s = setup(),
    job = deferred(),
    run = vi.fn(() => job.promise);
  const a = s.cache.read("host-a", request, run),
    b = s.cache.read("host-a", { ...request, refresh: true }, run);
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  job.resolve(s.snapshot());
  expect((await a).cache).toBe("network");
  expect((await b).cache).toBe("network");
});
test("distinct cold reads respect the two-process limit and queued work stops on disposal", async () => {
  const s = setup(),
    jobs = Array.from({ length: 4 }, deferred);
  const starts: number[] = [];
  const reads = jobs.map((job, i) =>
    s.cache.read(
      "host-a",
      requestSchema.parse({ kind: "thread", target: String(i).repeat(26) }),
      () => {
        starts.push(i);
        return job.promise;
      },
    ),
  );
  // Attach rejection handlers before disposal rejects queued reads.
  const all = Promise.allSettled(reads);
  await vi.waitFor(() => expect(starts).toHaveLength(2));
  jobs[0].resolve(s.snapshot());
  await vi.waitFor(() => expect(starts).toHaveLength(3));
  s.cache.dispose();
  jobs[1].resolve(s.snapshot());
  jobs[2].resolve(s.snapshot());
  const settled = await all;
  expect(settled[3].status).toBe("rejected");
  expect(starts).toEqual([0, 1, 2]);
});
