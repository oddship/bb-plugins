import {
  snapshotSchema,
  type Request,
  type Snapshot,
  type ReadResult,
} from "./contract";

export const MAX_AGE = 7 * 24 * 3600_000;
export const ttl = (r: Request) =>
  r.kind === "channels" ? 600_000 : r.kind === "search" ? 120_000 : 60_000;
export const cacheKey = (hostId: string, raw: Request) => {
  const { refresh, ...request } = raw;
  return JSON.stringify([hostId, request]);
};
export interface CacheStore {
  get(key: string): Snapshot | undefined;
  set(key: string, value: Snapshot): void;
}
type Job = {
  key: string;
  request: Request;
  run: () => Promise<Snapshot>;
  resolve: (v: Snapshot) => void;
  reject: (e: unknown) => void;
};
/** Two bounded CLI reads at a time; shared by panels, agents and CLI calls. */
export class ReadCache {
  private inFlight = new Map<string, Promise<Snapshot>>();
  private errors = new Map<string, { message: string; until: number }>();
  private queue: Job[] = [];
  private active = 0;
  private disposed = false;
  constructor(
    private store: CacheStore,
    private changed: (key: string) => void,
    private now = Date.now,
  ) {}
  peek(key: string) {
    const raw = this.store.get(key);
    const value = snapshotSchema.safeParse(raw);
    if (!value.success) return undefined;
    const age = this.now() - Date.parse(value.data.fetchedAt);
    return age >= 0 && age < MAX_AGE ? value.data : undefined;
  }
  private pump() {
    while (!this.disposed && this.active < 2 && this.queue.length) {
      const job = this.queue.shift()!;
      this.active++;
      Promise.resolve()
        .then(job.run)
        .then((value) => {
          const parsed = snapshotSchema.parse(value);
          if (!this.disposed) {
            this.store.set(job.key, parsed);
            this.errors.delete(job.key);
          }
          job.resolve(parsed);
        })
        .catch((error) => {
          this.errors.set(job.key, {
            message: "Refresh failed. Showing the last saved results.",
            until: this.now() + 30_000,
          });
          while (this.errors.size > 256)
            this.errors.delete(this.errors.keys().next().value!);
          job.reject(error);
        })
        .finally(() => {
          this.inFlight.delete(job.key);
          this.active--;
          if (!this.disposed) this.changed(job.key);
          this.pump();
        });
    }
  }
  private update(key: string, request: Request, run: () => Promise<Snapshot>) {
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    if (this.disposed)
      return Promise.reject(new Error("Mattermost plugin is reloading."));
    if (this.queue.length >= 32)
      return Promise.reject(
        new Error("Too many Mattermost requests. Try again shortly."),
      );
    const pending = new Promise<Snapshot>((resolve, reject) =>
      this.queue.push({ key, request, run, resolve, reject }),
    );
    this.inFlight.set(key, pending);
    this.pump();
    return pending;
  }
  async read(
    hostId: string,
    request: Request,
    run: () => Promise<Snapshot>,
  ): Promise<ReadResult> {
    const key = cacheKey(hostId, request),
      cached = this.peek(key);
    const fresh =
      cached && this.now() - Date.parse(cached.fetchedAt) < ttl(request);
    const error = this.errors.get(key);
    if (cached && !request.refresh) {
      if (!fresh && (!error || error.until <= this.now()))
        void this.update(key, request, run).catch(() => {});
      return {
        ...cached,
        cache: fresh ? "fresh" : "stale",
        refreshing: this.inFlight.has(key),
        ...(error ? { refreshError: error.message } : {}),
      };
    }
    try {
      return {
        ...(await this.update(key, request, run)),
        cache: "network",
        refreshing: false,
      };
    } catch (error) {
      if (cached)
        return {
          ...cached,
          cache: "stale",
          refreshing: false,
          refreshError: "Refresh failed. Showing the last saved results.",
        };
      throw error;
    }
  }
  dispose() {
    this.disposed = true;
    for (const job of this.queue)
      job.reject(new Error("Mattermost plugin is reloading."));
    this.queue = [];
  }
}
