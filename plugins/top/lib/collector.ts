import { open, readFile, readdir, readlink } from "node:fs/promises";
import { cpus, freemem, totalmem } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import type { ProcessRow, Sample, SessionOwner } from "../contract";

const exec = promisify(execFile);
export interface RawProcess extends ProcessRow {
  thread: string | null;
  ticks: number;
  start: string;
}
const THREAD = /^thr_[a-z0-9]{8,}$/;

// Codex app-server processes lack BB_THREAD_ID, but hold writer-lock files for
// the sessions they serve. Match those exact IDs to BB's thread/identity events.
// Never infer ownership from a working directory shared by several threads.
export function sessionFromLock(path: string): string | null {
  return (
    /\/thread-writer-locks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.lock$/.exec(
      path,
    )?.[1] ?? null
  );
}

export function ownerFromSessions(
  ids: string[],
  owners: SessionOwner[],
): string | null {
  const matches = new Set(
    owners
      .filter((owner) => ids.includes(owner.sessionId))
      .map((owner) => owner.threadId),
  );
  return matches.size === 1 ? [...matches][0] : null;
}

async function sessionOwner(
  pid: string,
  owners: SessionOwner[],
): Promise<string | null> {
  if (!owners.length) return null;
  const fds = (await readdir(`/proc/${pid}/fd`)).slice(0, 4096);
  const ids = (
    await mapLimit(fds, 16, async (fd) => {
      try {
        return sessionFromLock(await readlink(`/proc/${pid}/fd/${fd}`));
      } catch {
        return null;
      }
    })
  ).filter((id): id is string => id !== null);
  return ownerFromSessions(ids, owners);
}

export function threadFromEnvironment(buffer: Buffer): string | null {
  // Keep only the thread identifier. Environment and command arguments never leave the collector.
  for (const token of buffer.toString().split("\0")) {
    if (token.startsWith("BB_THREAD_ID=")) {
      const id = token.slice(13);
      return THREAD.test(id) ? id : null;
    }
  }
  return null;
}

export function parseStat(text: string, pageSize: number): RawProcess | null {
  const close = text.lastIndexOf(")");
  const first = text.indexOf("(");
  if (close < first || first < 1) return null;
  const fields = text
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  const pid = Number(text.slice(0, first).trim());
  const ppid = Number(fields[1]);
  const ticks = Number(fields[11]) + Number(fields[12]);
  const rss = Math.max(0, Number(fields[21]) * pageSize);
  if (![pid, ppid, ticks, rss].every(Number.isFinite) || !fields[19])
    return null;
  return {
    pid,
    ppid,
    name: text
      .slice(first + 1, close)
      .replace(/[\x00-\x1f\x7f]/g, "")
      .slice(0, 100),
    ticks,
    start: fields[19],
    thread: null,
    rss,
    cpu: 0,
  };
}

export function attribute(rows: RawProcess[]): Map<number, string | null> {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const result = new Map<number, string | null>();
  for (const row of rows) {
    const chain: number[] = [];
    const seen = new Set<number>();
    let current: RawProcess | undefined = row;
    let thread: string | null = null;
    while (current && !seen.has(current.pid)) {
      if (result.has(current.pid)) {
        thread = result.get(current.pid)!;
        break;
      }
      if (current.thread) {
        thread = current.thread;
        break;
      }
      seen.add(current.pid);
      chain.push(current.pid);
      if (current.pid <= 1) break;
      current = byPid.get(current.ppid);
    }
    result.set(row.pid, thread);
    for (const pid of chain) result.set(pid, thread);
  }
  return result;
}

export function measure(
  rows: RawProcess[],
  before: Map<number, RawProcess>,
  elapsedMs: number,
  ticksPerSecond: number,
) {
  for (const row of rows) {
    const old = before.get(row.pid);
    row.cpu =
      old && old.start === row.start && elapsedMs > 0
        ? Math.max(
            0,
            ((row.ticks - old.ticks) / ticksPerSecond / (elapsedMs / 1000)) *
              100,
          )
        : 0;
  }
}

export function group(rows: RawProcess[]): Sample["threads"] {
  const attribution = attribute(rows);
  const groups = new Map<string, Sample["threads"][number]>();
  for (const row of rows) {
    const id = attribution.get(row.pid);
    if (!id) continue;
    const item = groups.get(id) ?? {
      id,
      cpu: 0,
      rss: 0,
      count: 0,
      processes: [],
    };
    item.cpu += row.cpu;
    item.rss += row.rss;
    item.count++;
    item.processes.push({
      pid: row.pid,
      ppid: row.ppid,
      name: row.name,
      cpu: row.cpu,
      rss: row.rss,
    });
    groups.set(id, item);
  }
  let budget = 5000;
  return [...groups.values()]
    .sort((a, b) => b.cpu - a.cpu || b.rss - a.rss)
    .slice(0, 1000)
    .map((row) => {
      const processes = row.processes
        .sort((a, b) => b.cpu - a.cpu || b.rss - a.rss)
        .slice(0, Math.min(100, budget));
      budget -= processes.length;
      return { ...row, processes };
    });
}

export function hasOmittedDetails(threads: Sample["threads"]): boolean {
  return threads.some(thread => thread.processes.length < thread.count);
}

export async function mapLimit<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(items.length, concurrency) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

async function environment(pid: string): Promise<Buffer> {
  const handle = await open(`/proc/${pid}/environ`, "r");
  try {
    const buffer = Buffer.alloc(128 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function machineTimes() {
  return cpus().reduce(
    (sum, core) => ({
      idle: sum.idle + core.times.idle,
      total: sum.total + Object.values(core.times).reduce((a, b) => a + b, 0),
    }),
    { idle: 0, total: 0 },
  );
}

export class Collector {
  private previous = new Map<number, RawProcess>();
  private time = 0;
  private machine = machineTimes();
  private cached?: Sample;
  private pending?: Promise<Sample>;
  private constants?: Promise<[number, number]>;
  private disposed = false;
  dispose() {
    this.disposed = true;
    this.previous.clear();
    this.cached = undefined;
  }

  sample(sessionOwners: SessionOwner[] = []): Promise<Sample> {
    if (this.disposed) return Promise.reject(new Error("Collector disposed"));
    if (process.platform !== "linux")
      return Promise.reject(
        new Error("BB Top currently supports Linux machines."),
      );
    if (this.pending) return this.pending;
    if (this.cached && performance.now() - this.time < 2000)
      return Promise.resolve(this.cached);
    this.pending = this.read(sessionOwners).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async read(sessionOwners: SessionOwner[]): Promise<Sample> {
    this.constants ??= Promise.all(
      ["CLK_TCK", "PAGESIZE"].map(async (key) => {
        const { stdout } = await exec("getconf", [key], { timeout: 3000 });
        const value = Number(stdout.trim());
        if (!Number.isFinite(value) || value <= 0)
          throw new Error(`Invalid getconf ${key}`);
        return value;
      }),
    ) as Promise<[number, number]>;
    const [ticks, pageSize] = await this.constants;
    const ids = (await readdir("/proc")).filter((id) => /^\d+$/.test(id));
    let unreadable = 0;
    const rows = (
      await mapLimit(ids.slice(0, 100000), 24, async (pid) => {
        try {
          const text = await readFile(`/proc/${pid}/stat`, "utf8");
          const row = parseStat(text, pageSize);
          if (!row) {
            unreadable++;
            return null;
          }
          try {
            row.thread = threadFromEnvironment(await environment(pid));
          } catch {
            unreadable++;
          }
          if (!row.thread && row.name === "codex") {
            try {
              row.thread = await sessionOwner(pid, sessionOwners);
            } catch {
              /* inaccessible or exited */
            }
          }
          return row;
        } catch {
          unreadable++;
          return null;
        }
      })
    ).filter((row): row is RawProcess => row !== null);
    const now = performance.now();
    const elapsed = this.time ? now - this.time : 0;
    measure(rows, this.previous, elapsed, ticks);
    const times = machineTimes();
    const totalDelta = times.total - this.machine.total;
    const cpu =
      elapsed && totalDelta > 0
        ? Math.max(
            0,
            Math.min(
              100,
              (1 - (times.idle - this.machine.idle) / totalDelta) * 100,
            ),
          )
        : null;
    const threads = group(rows);
    let availableMemory = freemem();
    try {
      const info = await readFile("/proc/meminfo", "utf8");
      const available = /^MemAvailable:\s+(\d+) kB/m.exec(info);
      if (available) availableMemory = Number(available[1]) * 1024;
    } catch {
      /* os.freemem is the fallback */
    }
    if (this.disposed) throw new Error("Collector disposed");
    this.previous = new Map(rows.map((row) => [row.pid, row]));
    this.time = now;
    this.machine = times;
    const attribution = attribute(rows);
    this.cached = {
      at: Date.now(),
      intervalMs: elapsed,
      cores: cpus().length,
      cpu,
      totalMemory: totalmem(),
      availableMemory,
      scanned: rows.length,
      unreadable,
      unattributed: rows.filter((row) => !attribution.get(row.pid)).length,
      truncated:
        ids.length > 100000 ||
        new Set([...attribution.values()].filter(Boolean)).size > 1000 ||
        hasOmittedDetails(threads),
      threads,
    };
    return this.cached;
  }
}
