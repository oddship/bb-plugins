import test from "node:test";
import assert from "node:assert/strict";
import { Lifecycle, type Resource, type Allocation } from "./lifecycle.js";
import { Api, type VM } from "./api.js";
const signal = () => AbortSignal.timeout(3000);
const transport = {
  host: "localhost",
  port: 2224,
  fingerprint: "SHA256:test",
  identityFile: "",
};
const allocation: Allocation = {
  client_id: "client",
  kernel_id: "kernel",
  osimage_id: "image",
  cpus: 1,
  memory_mib: 1024,
  disk_size: "4G",
  targets: [],
};
class Fake extends Api {
  v: VM | null = null;
  posts = 0;
  ambiguous = false;
  loseReply = false;
  delayed = false;
  actions: string[] = [];
  constructor() {
    super("http://localhost:1323", "secret");
  }
  override async list() {
    return this.v ? [this.v] : [];
  }
  override async get() {
    return this.v;
  }
  override async request(
    path: string,
    s: AbortSignal,
    method = "GET",
    body?: unknown,
  ): Promise<unknown> {
    s.throwIfAborted();
    this.actions.push(method + " " + path);
    if (path === "/vms") {
      this.posts++;
      if (!this.ambiguous)
        this.v = {
          id: "vm",
          name: (body as { name: string }).name,
          client_id: "client",
          created_by: "account",
          status: "running",
          vm_id: "guest",
          expires_at: "",
        };
      if (this.ambiguous || this.loseReply) throw Error("lost reply");
      return this.v;
    }
    if (path.endsWith("/stop")) {
      if (!this.delayed) this.v!.status = "stopped";
      return this.v;
    }
    if (path.endsWith("/start")) {
      this.v!.status = "running";
      return this.v;
    }
    if (path.endsWith("/destroy")) {
      this.v!.status = "gone";
      return this.v;
    }
    if (method === "DELETE") {
      this.v = null;
      return null;
    }
    throw Error("unexpected");
  }
}
function fixture(timeout = 200) {
  const rows = new Map<string, Resource>();
  const store = {
    get: async (k: string) => rows.get(k) ?? null,
    set: async (k: string, r: Resource) => {
      rows.set(k, structuredClone(r));
    },
  };
  const api = new Fake();
  return {
    api,
    rows,
    store,
    life: new Lifecycle(api, store, "owner-123456789", "account", timeout),
  };
}
test("adoption reuses exact persistent VM, never allocates and disconnect retains disk", async () => {
  const f = fixture();
  f.api.v = {
    id: "existing",
    name: "my-vm",
    created_by: "account",
    client_id: "client",
    status: "running",
    vm_id: "guest",
    expires_at: "",
  };
  const r = await f.life.adopt(
    "adopt",
    "existing",
    "my-vm",
    transport,
    signal(),
  );
  assert.equal(r.adopted, true);
  assert.equal(
    (await f.life.allocate(r, allocation, signal())).vmId,
    "existing",
  );
  assert.equal(f.api.posts, 0);
  await f.life.remove(r, signal());
  assert.equal(f.api.v.id, "existing");
  assert.deepEqual(f.api.actions, []);
  assert.equal(f.rows.get("adopt")!.phase, "removed");
  await assert.rejects(
    f.life.adopt("adopt", "existing", "my-vm", transport, signal()),
    /identity changed/,
  );
});
test("adoption rejects stale name, foreign owner, expiring, missing and unstable VM", async () => {
  const f = fixture();
  const base = {
    id: "existing",
    name: "my-vm",
    created_by: "account",
    client_id: "client",
    status: "running",
    vm_id: "guest",
    expires_at: "",
  };
  for (const patch of [
    { name: "changed" },
    { created_by: "other" },
    { expires_at: "tomorrow" },
    { status: "pending" },
  ]) {
    f.api.v = { ...base, ...patch };
    await assert.rejects(
      f.life.adopt("adopt", "existing", "my-vm", transport, signal()),
      /owned, persistent/,
    );
  }
  f.api.v = null;
  await assert.rejects(
    f.life.adopt("adopt", "existing", "my-vm", transport, signal()),
    /owned, persistent/,
  );
  assert.equal(f.rows.size, 0);
  assert.deepEqual(f.api.actions, []);
});
async function allocate(f: ReturnType<typeof fixture>) {
  const r = await f.life.intent("stable", "client", transport);
  assert.ok(f.rows.has("stable"));
  return f.life.allocate(r, allocation, signal());
}
test("new friendly intents keep their name on retry and never adopt a pre-existing name collision", async () => {
  const f = fixture();
  const first = await f.life.intent("name", "client", transport, allocation);
  assert.match(first.name, /^[a-z]+-[a-z]+-\d{6}$/);
  assert.equal(
    (
      await f.life.intent(
        "name",
        "client",
        transport,
        allocation,
        "different-name",
      )
    ).name,
    first.name,
  );
  f.api.v = {
    id: "collision",
    name: first.name,
    client_id: "client",
    created_by: "account",
    status: "running",
    vm_id: "guest",
    expires_at: "",
  };
  await assert.rejects(
    f.life.allocate(first, allocation, signal()),
    /already exists/,
  );
  assert.equal(f.api.posts, 0);
});
test("intent persisted before POST, allocated resource survives plugin restart and bootstrap failure", async () => {
  const f = fixture();
  const r = await allocate(f);
  assert.equal(f.api.posts, 1);
  const restarted = new Lifecycle(f.api, f.store, "owner-123456789", "account");
  const retry = await restarted.allocate(
    (await f.store.get("stable"))!,
    allocation,
    signal(),
  );
  assert.deepEqual(retry, r);
  assert.equal(f.api.posts, 1);
});
test("ambiguous allocation without match refuses duplicate after restart", async () => {
  const f = fixture();
  f.api.ambiguous = true;
  await assert.rejects(allocate(f), /lost reply/);
  assert.equal(f.rows.get("stable")?.phase, "posting");
  await assert.rejects(allocate(f), /uncertain/);
  assert.equal(f.api.posts, 1);
  await assert.rejects(
    f.life.remove(f.rows.get("stable")!, signal()),
    /Uncertain/,
  );
});
test("lost POST response reconciles exact allocation", async () => {
  const f = fixture();
  f.api.loseReply = true;
  const r = await allocate(f);
  assert.equal(r.vmId, "vm");
  assert.equal(f.api.posts, 1);
});
test("cancellation prevents network allocation and preserves prepared intent", async () => {
  const f = fixture();
  const r = await f.life.intent("stable", "client", transport);
  await assert.rejects(f.life.allocate(r, allocation, AbortSignal.abort()));
  assert.equal(f.api.posts, 0);
  assert.equal(f.rows.get("stable")?.phase, "prepared");
});
test("stopped VM resumes same disk and repeated stop/start are idempotent", async () => {
  const f = fixture();
  const r = await allocate(f);
  await f.life.stop(r, signal());
  await f.life.stop(r, signal());
  assert.equal(f.api.v!.status, "stopped");
  await f.life.start(r, signal());
  await f.life.start(r, signal());
  assert.equal(f.api.posts, 1);
  assert.equal(f.api.actions.filter((x) => x.endsWith("/start")).length, 1);
  assert.equal(f.api.v!.id, "vm");
});
test("suspend does not succeed on asynchronous stop acceptance alone", async () => {
  const f = fixture(1);
  const r = await allocate(f);
  f.api.delayed = true;
  await assert.rejects(f.life.stop(r, signal()), /Timed out|aborted|timeout/i);
  assert.equal(f.api.v!.status, "running");
});
test("lost VM refuses silent replacement", async () => {
  const f = fixture();
  await allocate(f);
  f.api.v = null;
  await assert.rejects(allocate(f), /lost/);
  assert.equal(f.api.posts, 1);
});
test("ownership and endpoint/account changes block destructive operations", async () => {
  const f = fixture();
  const r = await allocate(f);
  f.api.v!.created_by = "other";
  await assert.rejects(f.life.remove(r, signal()), /ownership/);
  f.api.v!.created_by = "account";
  await assert.rejects(
    f.life.remove({ ...r, endpoint: "https://other.test" }, signal()),
    /changed/,
  );
  assert.ok(!f.api.actions.some((x) => x.endsWith("/destroy")));
});
test("cleanup retries after pending allocation, waits for destruction and retains tombstone", async () => {
  const f = fixture();
  const r = await allocate(f);
  f.api.v!.status = "pending";
  await assert.rejects(f.life.remove(r, signal()), /pending/);
  f.api.v!.status = "running";
  await f.life.remove(r, signal());
  await f.life.remove((await f.store.get("stable"))!, signal());
  assert.equal(f.api.v, null);
  assert.equal(f.rows.get("stable")?.phase, "removed");
  await assert.rejects(allocate(f), /explicitly removed/);
});
test("expired VM is never adopted as persistent", async () => {
  const f = fixture();
  await allocate(f);
  f.api.v!.expires_at = "tomorrow";
  await assert.rejects(allocate(f), /lifetime mismatch/);
});
test("prepared intent retains original allocation choices across settings changes", async () => {
  const f = fixture();
  const r = await f.life.intent("stable", "client", transport, allocation);
  const changed = { ...allocation, client_id: "different-client" };
  await f.life.allocate(r, changed, signal());
  assert.equal(f.api.v!.client_id, "client");
  assert.equal(f.rows.get("stable")!.allocation!.client_id, "client");
});

test("definitive HTTP rejection before insertion can be cleaned without permanent uncertainty", async () => {
  const { ApiError } = await import("./api.js");
  const f = fixture();
  f.api.request = async () => {
    throw new ApiError(403);
  };
  await assert.rejects(allocate(f), /403/);
  assert.equal(f.rows.get("stable")!.phase, "prepared");
  await f.life.remove(f.rows.get("stable")!, signal());
  assert.equal(f.rows.get("stable")!.phase, "removed");
});
test("readiness polling tolerates a transient control request failure", async () => {
  const { TransientError } = await import("./api.js");
  const f = fixture(2500);
  const r = await allocate(f);
  const get = f.api.get.bind(f.api);
  let once = true;
  f.api.get = async () => {
    if (once) {
      once = false;
      throw new TransientError("temporary");
    }
    return get();
  };
  await f.life.wait(r, signal(), "running");
});
