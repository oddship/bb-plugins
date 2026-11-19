import test from "node:test";
import assert from "node:assert/strict";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makeHostResponse,
} from "@get-bb/plugin-sdk/testing";
import { Api, ApiError, TransientError, type VM } from "./api.js";
import { Manager, apiRule, type Config } from "./manager.js";
import { Lifecycle, type Resource } from "./lifecycle.js";
import { managerMethods, type Profile, type Rule } from "./manager-contract.js";
import plugin from "./server.js";
const VMID = "10000000-0000-4000-8000-000000000001",
  CLIENT = "10000000-0000-4000-8000-000000000002",
  KERNEL = "10000000-0000-4000-8000-000000000003",
  IMAGE = "10000000-0000-4000-8000-000000000004",
  ACCOUNT = "10000000-0000-4000-8000-000000000005",
  KEY = "10000000-0000-4000-8000-000000000006",
  RULE = "10000000-0000-4000-8000-000000000007";
const baseVM = (): VM => ({
  id: VMID,
  name: "sample-vm",
  client_id: CLIENT,
  created_by: ACCOUNT,
  status: "stopped",
  vm_id: "guest",
  expires_at: "",
  cpus: 2,
  memory_mib: 2048,
  disk_mib: 4096,
  kernel_id: KERNEL,
  boot: "direct",
  default_port: 8000,
  public_ports: [],
  default_user: "ubuntu",
  created_at: new Date().toISOString(),
});
const profile = (): Profile => ({
  host: CLIENT,
  kernel: KERNEL,
  image: IMAGE,
  cpus: 2,
  memoryMiB: 2048,
  disk: "4G",
  targets: [],
});
const rule = (): Rule => ({
  kind: "domain",
  destination: "example.com",
  transport: "tcp",
  ports: "443",
  note: "test",
  ttlSeconds: 0,
});
class Fake extends Api {
  vm: VM | null = baseVM();
  mutations: { method: string; path: string; body: unknown }[] = [];
  quota = {
    vcpu_limit: 16,
    vcpu_used: 2,
    memory_limit_mib: 16384,
    memory_used_mib: 2048,
    disk_limit_mib: 65536,
    disk_used_mib: 4096,
  };
  ambiguous = false;
  commitLost = false;
  actionLost = false;
  online = true;
  rules: any[] = [];
  constructor() {
    super("http://127.0.0.1:1323", "fake-secret");
  }
  override async request(
    path: string,
    signal: AbortSignal,
    method = "GET",
    body?: unknown,
  ): Promise<unknown> {
    signal.throwIfAborted();
    if (method !== "GET") this.mutations.push({ method, path, body });
    if (path === "/me") return { id: ACCOUNT };
    if (path === "/health") return { status: "ok" };
    if (path === "/vms/quota") return this.quota;
    if (path === "/vms/hosts")
      return {
        items: this.online ? [{ id: CLIENT, hostname: "Local host" }] : [],
      };
    if (path === "/vms/kernels")
      return {
        items: [{ id: KERNEL, name: "Linux kernel", size_bytes: 12000000 }],
      };
    if (path === "/vms/osimages")
      return {
        items: [
          {
            id: IMAGE,
            name: "Node image",
            description: "Node 22",
            size_bytes: 600000000,
            source: "upload",
          },
        ],
      };
    if (method === "GET" && path.startsWith("/vms?"))
      return { items: this.vm ? [this.vm] : [], total: this.vm ? 1 : 0 };
    if (path === "/vms" && method === "POST") {
      const b = body as any;
      if (!this.ambiguous || this.commitLost)
        this.vm = {
          ...baseVM(),
          name: b.name,
          client_id: b.client_id,
          cpus: b.cpus,
          memory_mib: b.memory_mib,
          disk_mib:
            Number(b.disk_size.slice(0, -1)) *
            (b.disk_size.endsWith("G") ? 1024 : 1),
          kernel_id: b.kernel_id,
          status: "pending",
        };
      if (this.ambiguous) throw new TransientError("lost reply");
      return this.vm;
    }
    if (path === `/vms/${VMID}`) {
      if (method === "DELETE") {
        this.vm = null;
        return null;
      }
      if (!this.vm) throw new ApiError(404);
      return this.vm;
    }
    if (path === `/vms/${VMID}/targets`) {
      if (method === "GET") return { items: this.rules };
      if (method === "POST") {
        const b = body as any;
        const t = {
          ...b,
          id: RULE,
          transport: b.kind === "domain" ? "" : b.transport,
          expires_at: "",
        };
        this.rules.push(t);
        return t;
      }
    }
    if (path.startsWith(`/vms/${VMID}/targets/`)) {
      const index = this.rules.findIndex((r) => r.id === path.split("/").pop());
      if (index < 0) throw new ApiError(404);
      if (method === "DELETE") {
        this.rules.splice(index, 1);
        return null;
      }
      this.rules[index] = { ...(body as object), id: RULE, expires_at: "" };
      return this.rules[index];
    }
    if (method === "PUT") {
      if (!this.vm) throw new ApiError(404);
      const b = body as any;
      if (path.endsWith("/size"))
        Object.assign(this.vm, {
          cpus: b.cpus,
          memory_mib: b.memory_mib,
          disk_mib:
            Number(b.disk_size.slice(0, -1)) *
            (b.disk_size.endsWith("G") ? 1024 : 1),
        });
      else Object.assign(this.vm, b);
      return this.vm;
    }
    if (method === "POST") {
      if (this.actionLost) throw new TransientError("lost action");
      return this.vm;
    }
    throw Error("Unexpected fake call " + method + " " + path);
  }
}
function fixture() {
  const api = new Fake();
  let records: Resource[] = [];
  let core: any[] = [];
  let coreResource: unknown = null;
  const { bb, harness } = createFakePluginHost({
    pluginId: "dummie",
    machineResource: async () => coreResource as any,
  });
  harness.inspection.sdk.stub("hosts.list", async () => core);
  for (const name of [
    "experimental_suspend",
    "experimental_resume",
    "experimental_reconcile",
    "experimental_retryCleanup",
    "delete",
  ])
    harness.inspection.sdk.stub("hosts." + name, async () => ({ ok: true }));
  const cfg: Config = {
    host: CLIENT,
    kernel: KERNEL,
    image: IMAGE,
    cpus: 2,
    memory: 2048,
    disk: "4G",
    targets: "[]",
    hostNetworkNotice: "",
  };
  const active = new Set<string>();
  let saved: Profile | null = null;
  const mgr = new Manager({
    bb,
    owner: "private-owner",
    signal: new AbortController().signal,
    resources: async () => records,
    saveDefaults: async (p) => {
      saved = p;
    },
    connect: async () => ({
      api,
      cfg,
      life: new Lifecycle(
        api,
        { get: async () => null, set: async () => {} },
        "private-owner",
        ACCOUNT,
      ),
    }),
    locked: async (key, fn) => {
      if (active.has(key)) throw Error("busy");
      active.add(key);
      try {
        return await fn();
      } finally {
        active.delete(key);
      }
    },
  });
  const resource = (): Resource => ({
    version: 1,
    key: "allocation",
    owner: "private-owner",
    endpoint: api.origin,
    account: ACCOUNT,
    name: "sample-vm",
    client: CLIENT,
    vmId: VMID,
    phase: "allocated",
    enrolled: true,
    transport: {
      host: "localhost",
      port: 2224,
      fingerprint: "public-fingerprint",
      identityFile: "/private/key/path",
    },
  });
  const managed = (
    phase = "active",
    status: "connected" | "disconnected" = "connected",
  ) => {
    records = [resource()];
    coreResource = resource();
    core = [
      makeHostResponse({
        id: "host_managed",
        name: "BB guest",
        machineProviderId: "dummie",
        status,
        lifecycle: {
          phase: phase as any,
          suspendedAt: null,
          message: null,
          pendingLog: "",
          teardown:
            phase === "removing" ? { status: "failed", attempt: 0 } : null,
        },
      }),
    ];
  };
  return {
    api,
    bb,
    harness,
    mgr,
    cfg,
    resource,
    managed,
    setRecords: (r: Resource[]) => (records = r),
    setCoreResource: (r: unknown) => {
      coreResource = r;
      core = [
        makeHostResponse({ id: "host_managed", machineProviderId: "dummie" }),
      ];
    },
    saved: () => saved,
    dispose: () => harness.lifecycle.dispose(),
  };
}
const identity = { id: VMID, expectedName: "sample-vm" };
const inventory = { search: "", status: "all", offset: 0, limit: 20 };
test("account inventory contains readable metadata and no private ownership or key data", async () => {
  const f = fixture();
  f.managed();
  try {
    const data = await f.mgr.inventory(inventory);
    assert.equal(data.vms[0]!.management, "bb");
    assert.equal(data.vms[0]!.hostName, "Local host");
    assert.equal(data.vms[0]!.kernelName, "Linux kernel");
    const serialized = JSON.stringify(data);
    for (const hidden of [
      "/private/key/path",
      "private-owner",
      ACCOUNT,
      "fake-secret",
    ])
      assert.ok(!serialized.includes(hidden));
    assert.equal(
      (await f.mgr.inventory({ ...inventory, search: "missing" })).vms.length,
      0,
    );
    assert.equal(
      (await f.mgr.inventory({ ...inventory, status: "running" })).total,
      0,
    );
  } finally {
    await f.dispose();
  }
});
test("managed lifecycle actions route through BB core; raw operations are never used", async () => {
  const f = fixture();
  f.managed();
  try {
    await f.mgr.action({ ...identity, action: "stop" });
    assert.equal(
      f.harness.inspection.sdk.callsTo("hosts.experimental_suspend").length,
      1,
    );
    f.managed("suspended", "disconnected");
    await f.mgr.action({ ...identity, action: "start" });
    await f.mgr.action({ ...identity, action: "reconcile" });
    assert.equal(
      f.harness.inspection.sdk.callsTo("hosts.experimental_resume").length,
      1,
    );
    assert.equal(
      f.harness.inspection.sdk.callsTo("hosts.experimental_reconcile").length,
      1,
    );
    assert.equal(f.api.mutations.length, 0);
  } finally {
    await f.dispose();
  }
});
test("managed removal requires exact VM name and authorizes only the validated core resource", async () => {
  const f = fixture();
  f.managed();
  try {
    await assert.rejects(
      f.mgr.action({ ...identity, action: "remove", confirmation: "BB guest" }),
      /exact VM name/,
    );
    assert.equal(f.api.mutations.length, 0);
    await f.mgr.action({
      ...identity,
      action: "remove",
      confirmation: "sample-vm",
    });
    assert.equal(f.harness.inspection.sdk.callsTo("hosts.delete").length, 1);
    assert.equal(await f.bb.storage.kv.get("remove-approved:allocation"), true);
    assert.equal(f.api.mutations.length, 0);
  } finally {
    await f.dispose();
  }
});
test("managed edits and egress writes are explicitly unavailable, including a client-managed flag spoof", async () => {
  const f = fixture();
  f.managed();
  try {
    await assert.rejects(
      f.mgr.edit({ ...identity, kind: "user", defaultUser: "root" }),
      /BB owns/,
    );
    await assert.rejects(
      f.mgr.edit({
        ...identity,
        kind: "size",
        cpus: 4,
        memoryMiB: 4096,
        disk: "8G",
      }),
      /BB owns/,
    );
    await assert.rejects(
      f.mgr.saveTarget({ ...identity, rule: rule() }),
      /BB owns/,
    );
    await assert.rejects(
      f.mgr.action({ ...identity, action: "stop", managed: false }),
      /Unrecognized/,
    );
    assert.equal(f.api.mutations.length, 0);
  } finally {
    await f.dispose();
  }
});
test("managed status is rechecked on mutation after a plain inventory response", async () => {
  const f = fixture();
  try {
    assert.equal((await f.mgr.detail(VMID)).vm!.management, "plain");
    f.managed();
    await f.mgr.action({ ...identity, action: "stop" });
    assert.equal(
      f.harness.inspection.sdk.callsTo("hosts.experimental_suspend").length,
      1,
    );
    assert.equal(f.api.mutations.length, 0);
  } finally {
    await f.dispose();
  }
});
test("busy core lifecycle states and pending plain VMs refuse mutations", async () => {
  const f = fixture();
  try {
    for (const phase of ["creating", "resuming", "suspending"]) {
      f.managed(phase);
      await assert.rejects(
        f.mgr.action({ ...identity, action: "stop" }),
        /Wait for/,
      );
    }
    f.setRecords([]);
    f.setCoreResource(null);
    f.api.vm!.status = "pending";
    await assert.rejects(
      f.mgr.action({
        ...identity,
        action: "remove",
        confirmation: "sample-vm",
      }),
      /wait for a stable/i,
    );
    assert.equal(f.api.mutations.length, 0);
  } finally {
    await f.dispose();
  }
});
test("existing enrollment uses a stable core key, rejects pending operations and never allocates through Dummie", async () => {
  const f = fixture();
  const calls: any[] = [];
  f.harness.inspection.sdk.stub("hosts.experimental_create", async (input) => {
    calls.push(input);
    return makeHostResponse({ id: "host_adopted" });
  });
  try {
    const one = await f.mgr.enroll(identity);
    const two = await f.mgr.enroll(identity);
    assert.equal(one.hostId, "host_adopted");
    assert.equal(two.hostId, one.hostId);
    assert.equal(calls[0].key, calls[1].key);
    assert.deepEqual(calls[0].inputs, {
      existingVmId: VMID,
      expectedName: "sample-vm",
      connection: "remote",
    });
    assert.equal(f.api.mutations.length, 0);
    f.setRecords([
      { ...f.resource(), key: calls[0].key, phase: "removed", adopted: true },
    ]);
    await f.mgr.enroll(identity);
    assert.notEqual(
      calls[2].key,
      calls[0].key,
      "Disconnected VM gets a new enrollment reservation",
    );
    f.api.vm!.expires_at = "tomorrow";
    await assert.rejects(f.mgr.enroll(identity), /persistent/);
    f.api.vm!.expires_at = "";
    await f.mgr.action({ ...identity, action: "start" });
    await assert.rejects(f.mgr.enroll(identity), /pending operation/);
  } finally {
    await f.dispose();
  }
});
test("another connection's same-name VM does not shadow current account inventory", async () => {
  const f = fixture();
  try {
    f.setRecords([
      {
        ...f.resource(),
        endpoint: "https://remote.example.com",
        vmId: "different-id",
      },
    ]);
    assert.equal((await f.mgr.detail(VMID)).vm!.management, "plain");
  } finally {
    await f.dispose();
  }
});
test("uncertain, transferred and malformed matching ownership records are protected", async () => {
  const f = fixture();
  try {
    const r = f.resource();
    delete r.vmId;
    r.phase = "posting";
    r.enrolled = false;
    f.setRecords([r]);
    assert.equal((await f.mgr.detail(VMID)).vm!.management, "protected");
    await assert.rejects(
      f.mgr.action({ ...identity, action: "stop" }),
      /tracked/i,
    );
    f.setRecords([{ ...f.resource(), transferredTo: "another" }]);
    await assert.rejects(
      f.mgr.action({
        ...identity,
        action: "remove",
        confirmation: "sample-vm",
      }),
      /tracked/i,
    );
    f.setRecords([]);
    f.setCoreResource({ vmId: VMID, name: "sample-vm" });
    assert.equal((await f.mgr.detail(VMID)).vm!.management, "protected");
    assert.equal(f.api.mutations.length, 0);
  } finally {
    await f.dispose();
  }
});
test("account, endpoint and expected identity mismatches fail closed", async () => {
  const f = fixture();
  try {
    f.api.vm!.created_by = "different";
    await assert.rejects(
      f.mgr.action({ ...identity, action: "start" }),
      /authenticated account/,
    );
    f.api.vm!.created_by = ACCOUNT;
    await assert.rejects(
      f.mgr.action({ ...identity, expectedName: "other-vm", action: "start" }),
      /name changed/,
    );
    f.managed();
    f.setRecords([{ ...f.resource(), endpoint: "http://localhost:9999" }]);
    await assert.rejects(
      f.mgr.action({
        ...identity,
        action: "remove",
        confirmation: "sample-vm",
      }),
      /identity|endpoint/i,
    );
    assert.equal(f.api.mutations.length, 0);
  } finally {
    await f.dispose();
  }
});
test("plain async start is observed, not assumed; repeated submissions are blocked", async () => {
  const f = fixture();
  try {
    await f.mgr.action({ ...identity, action: "start" });
    const pending = await f.mgr.detail(VMID);
    assert.equal(pending.operation!.state, "pending");
    await assert.rejects(
      f.mgr.action({ ...identity, action: "start" }),
      /confirmation/,
    );
    assert.equal(f.api.mutations.length, 1);
    f.api.vm!.status = "running";
    assert.equal((await f.mgr.detail(VMID)).operation!.state, "complete");
  } finally {
    await f.dispose();
  }
});
test("plain removal destroys before purging and never repeats destruction", async () => {
  const f = fixture();
  try {
    f.api.vm!.status = "running";
    await assert.rejects(
      f.mgr.action({ ...identity, action: "remove", confirmation: "wrong" }),
      /exact VM name/,
    );
    await f.mgr.action({
      ...identity,
      action: "remove",
      confirmation: "sample-vm",
    });
    assert.equal(f.api.mutations[0]!.path, "/vms/" + VMID + "/destroy");
    await f.mgr.detail(VMID);
    assert.equal(f.api.mutations.length, 1);
    f.api.vm!.status = "gone";
    const result = await f.mgr.detail(VMID);
    assert.equal(result.vm, null);
    assert.equal(result.operation!.state, "complete");
    assert.equal(f.api.mutations[1]!.method, "DELETE");
  } finally {
    await f.dispose();
  }
});
test("uncertain plain actions reconcile actual state without a second POST", async () => {
  const f = fixture();
  try {
    f.api.vm!.status = "running";
    f.api.actionLost = true;
    await f.mgr.action({ ...identity, action: "stop" });
    await assert.rejects(
      f.mgr.action({ ...identity, action: "stop" }),
      /uncertain/i,
    );
    assert.equal(f.api.mutations.length, 1);
    f.api.vm!.status = "stopped";
    assert.equal((await f.mgr.detail(VMID)).operation!.state, "complete");
  } finally {
    await f.dispose();
  }
});
test("plain ports, session user and stopped size edits use supported APIs with growth/quota protection", async () => {
  const f = fixture();
  try {
    f.api.vm!.status = "running";
    await assert.rejects(
      f.mgr.edit({
        ...identity,
        kind: "size",
        cpus: 2,
        memoryMiB: 2048,
        disk: "8G",
      }),
      /Stop this plain/,
    );
    await f.mgr.edit({
      ...identity,
      kind: "ports",
      defaultPort: 3000,
      publicPorts: [3000, 3000, 8000],
    });
    assert.deepEqual(f.api.vm!.public_ports, [3000, 8000]);
    await f.mgr.edit({ ...identity, kind: "user", defaultUser: "app" });
    f.api.vm!.status = "stopped";
    await assert.rejects(
      f.mgr.edit({
        ...identity,
        kind: "size",
        cpus: 2,
        memoryMiB: 2048,
        disk: "2G",
      }),
      /shrinking/,
    );
    await f.mgr.edit({
      ...identity,
      kind: "size",
      cpus: 3,
      memoryMiB: 4096,
      disk: "8G",
    });
    assert.equal(f.api.vm!.disk_mib, 8192);
    assert.ok(!JSON.stringify(f.api.mutations).includes("kernel_id"));
  } finally {
    await f.dispose();
  }
});
test("egress create/edit/remove validates a fresh rule and exact destination confirmation", async () => {
  const f = fixture();
  try {
    await f.mgr.saveTarget({ ...identity, rule: rule() });
    assert.equal(
      (await f.mgr.detail(VMID)).targets[0]!.rule.destination,
      "example.com",
    );
    await f.mgr.saveTarget({
      ...identity,
      targetId: RULE,
      rule: { ...rule(), ports: "80" },
    });
    await assert.rejects(
      f.mgr.removeTarget({
        ...identity,
        targetId: RULE,
        confirmation: "wrong",
      }),
      /exact destination/,
    );
    await f.mgr.removeTarget({
      ...identity,
      targetId: RULE,
      confirmation: "example.com",
    });
    assert.equal(f.api.rules.length, 0);
  } finally {
    await f.dispose();
  }
});
test("plain creates retain intent on an ambiguous response and never send duplicate allocations", async () => {
  const f = fixture();
  try {
    f.api.ambiguous = true;
    const input = {
      key: KEY,
      mode: "plain",
      name: "new-test-vm",
      profile: profile(),
      acknowledgeHostNotice: true,
    };
    const first = await f.mgr.create(input);
    assert.equal(first.state, "posting");
    assert.equal((await f.mgr.create(input)).state, "posting");
    await f.mgr.request(KEY);
    assert.equal(f.api.mutations.filter((m) => m.path === "/vms").length, 1);
    await assert.rejects(
      f.mgr.create({ ...input, name: "another-vm" }),
      /different inputs/,
    );
  } finally {
    await f.dispose();
  }
});
test("a committed plain create with lost reply reconciles matching identity and creation metadata", async () => {
  const f = fixture();
  try {
    f.api.ambiguous = true;
    f.api.commitLost = true;
    await f.mgr.create({
      key: KEY,
      mode: "plain",
      name: "new-test-vm",
      profile: profile(),
      acknowledgeHostNotice: true,
    });
    const recovered = await f.mgr.request(KEY);
    assert.equal(recovered.state, "confirmed");
    assert.equal(recovered.vmId, VMID);
    assert.equal(f.api.mutations.length, 1);
  } finally {
    await f.dispose();
  }
});
test("BB creates and uncertain retries use the same stable core key, never raw Dummie allocation", async () => {
  const f = fixture();
  let once = true;
  f.harness.inspection.sdk.stub("hosts.experimental_create", async () => {
    if (once) {
      once = false;
      throw Error("lost core reply");
    }
    return makeHostResponse({ id: "host_new", machineProviderId: "dummie" });
  });
  try {
    const first = await f.mgr.create({
      key: KEY,
      mode: "bb",
      profile: profile(),
      acknowledgeHostNotice: true,
    });
    assert.equal(first.state, "posting");
    assert.equal((await f.mgr.request(KEY)).hostId, "host_new");
    const calls = f.harness.inspection.sdk.callsTo("hosts.experimental_create");
    assert.equal(calls.length, 2);
    assert.equal((calls[0]![0] as any).key, (calls[1]![0] as any).key);
    assert.equal(f.api.mutations.length, 0);
  } finally {
    await f.dispose();
  }
});
test("new allocation respects quota and host prerequisite before any resource POST", async () => {
  const f = fixture();
  try {
    const input = {
      key: KEY,
      mode: "plain",
      name: "new-test-vm",
      profile: profile(),
      acknowledgeHostNotice: false,
    };
    f.cfg.hostNetworkNotice = "Review forwarding";
    await assert.rejects(f.mgr.create(input), /prerequisite/);
    f.cfg.hostNetworkNotice = "";
    f.api.quota.vcpu_limit = 2;
    await assert.rejects(f.mgr.create(input), /quota/);
    assert.equal(f.api.mutations.length, 0);
  } finally {
    await f.dispose();
  }
});
test("catalog/defaults are named, read only, and saving defaults does not edit VMs", async () => {
  const f = fixture();
  try {
    const setup = await f.mgr.setup();
    assert.equal(setup.hosts[0]!.name, "Local host");
    assert.equal(setup.images[0]!.name, "Node image");
    await f.mgr.saveDefaults(profile());
    assert.equal(f.saved()!.image, IMAGE);
    await assert.rejects(
      f.mgr.saveDefaults({
        ...profile(),
        kernel: "20000000-0000-4000-8000-000000000001",
      }),
      /available/,
    );
    assert.equal(f.api.mutations.length, 0);
  } finally {
    await f.dispose();
  }
});
test("SDK RPC schemas reject malformed IDs, spoofed management, rename/kernel writes and invalid ports", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "dummie" });
  await plugin(bb);
  try {
    for (const [method, input] of [
      ["manager_detail", { id: "../../other" }],
      [
        "manager_action",
        {
          ...identity,
          action: "remove",
          managed: false,
          confirmation: "sample-vm",
        },
      ],
      ["manager_edit", { ...identity, kind: "rename", name: "different" }],
      [
        "manager_edit",
        {
          ...identity,
          kind: "size",
          cpus: 2,
          memoryMiB: 2048,
          disk: "8G",
          kernelId: KERNEL,
        },
      ],
      [
        "manager_edit",
        { ...identity, kind: "ports", defaultPort: 99999, publicPorts: [] },
      ],
      [
        "manager_target_save",
        {
          ...identity,
          rule: {
            ...rule(),
            kind: "ip",
            destination: "0.0.0.0/0",
            transport: "any",
            ports: "",
          },
        },
      ],
    ] as const)
      await assert.rejects(harness.behavior.callRpc(method, input));
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("a setup queue failure preserves the confirmed VM receipt and can be retried without another allocation", async () => {
  const f = fixture();
  const recipe = {
    id: KEY,
    revision: 1,
    name: "Test setup",
    description: "",
    mode: "plain" as const,
    profile: null,
    bootstrapScript: "echo test",
    timeoutSeconds: 60,
    builtin: false,
  };
  let queued = 0;
  f.mgr.deps.getRecipe = async () => recipe;
  f.mgr.deps.queueRecipe = async () => {
    const receipt = await f.bb.storage.kv.get<{ state: string; vmId: string }>(
      "manager:create:" + KEY,
    );
    assert.equal(receipt!.state, "confirmed");
    assert.equal(receipt!.vmId, VMID);
    queued++;
    throw Error("Connection changed before setup was queued");
  };
  try {
    const result = await f.mgr.create({
      key: KEY,
      mode: "plain",
      name: "new-friendly-machine",
      profile: profile(),
      acknowledgeHostNotice: true,
      recipeId: KEY,
      recipeRevision: 1,
    });
    assert.equal(result.state, "confirmed");
    assert.equal(result.vmId, VMID);
    assert.match(result.message, /could not be queued/);
    f.mgr.deps.queueRecipe = async () => {
      queued++;
    };
    assert.equal((await f.mgr.request(KEY)).state, "confirmed");
    assert.equal(queued, 2);
    assert.equal(
      f.api.mutations.filter((m) => m.path === "/vms" && m.method === "POST")
        .length,
      1,
    );
  } finally {
    await f.dispose();
  }
});

const integrationId = "10000000-0000-4000-8000-000000000099";
function integrationFixture(
  f: ReturnType<typeof fixture>,
  failScope = false,
  attached = false,
  kind = "github",
) {
  const original = f.api.request.bind(f.api);
  const integration = {
    id: integrationId,
    name: "work",
    kind,
    connected: true,
    suspended: false,
    readonly: true,
    repos: ["example/frontend", "example/backend"],
    token: "must-not-leak",
  };
  const changes: string[] = [];
  f.api.request = async (path, signal, method = "GET", body) => {
    if (path === "/integrations") return { items: [integration] };
    if (path === `/integrations/${integrationId}` && method === "GET")
      return integration;
    if (path === `/vms/${VMID}/integrations`)
      return { items: attached ? [integration] : [] };
    if (path.startsWith(`/integrations/${integrationId}/vms/${VMID}`)) {
      changes.push(method);
      if (method === "PUT" && failScope) throw Error("scope failed");
      if (method === "PUT")
        assert.deepEqual(body, { repos: ["example/frontend"] });
      return null;
    }
    return original(path, signal, method, body);
  };
  return changes;
}
test("integration choices strip secrets and save explicit repository scope for managed VMs", async () => {
  const f = fixture();
  f.managed();
  const changes = integrationFixture(f);
  try {
    const status = await f.mgr.integrations(VMID);
    assert.equal(JSON.stringify(status).includes("must-not-leak"), false);
    await f.mgr.saveIntegration({
      ...identity,
      integrationId,
      repos: ["example/frontend"],
    });
    assert.deepEqual(changes, ["POST", "PUT"]);
    await assert.rejects(
      f.mgr.saveIntegration({ ...identity, integrationId, repos: [] }),
    );
    await assert.rejects(
      f.mgr.saveIntegration({
        ...identity,
        integrationId,
        repos: ["other/repo"],
      }),
    );
    await assert.rejects(
      f.mgr.saveIntegration({
        ...identity,
        expectedName: "wrong-name",
        integrationId,
        repos: ["example/frontend"],
      }),
    );
    assert.deepEqual(changes, ["POST", "PUT"]);
  } finally {
    await f.dispose();
  }
});
test("failed initial repository scope detaches, but existing attachments are preserved", async () => {
  for (const attached of [false, true]) {
    const f = fixture();
    f.managed();
    const changes = integrationFixture(f, true, attached);
    try {
      await assert.rejects(
        f.mgr.saveIntegration({
          ...identity,
          integrationId,
          repos: ["example/frontend"],
        }),
        /scope failed/,
      );
      assert.deepEqual(changes, attached ? ["PUT"] : ["POST", "PUT", "DELETE"]);
    } finally {
      await f.dispose();
    }
  }
});

test("GitLab requires explicit token-scope acceptance and never calls repository scoping", async () => {
  const f = fixture();
  f.managed();
  const changes = integrationFixture(f, false, false, "gitlab");
  try {
    await assert.rejects(
      f.mgr.saveIntegration({ ...identity, integrationId, repos: [] }),
      /Review and accept/,
    );
    await assert.rejects(
      f.mgr.saveIntegration({
        ...identity,
        integrationId,
        acceptTokenScope: true,
        repos: ["example/frontend"],
      }),
      /Review and accept/,
    );
    assert.deepEqual(changes, []);
    await f.mgr.saveIntegration({
      ...identity,
      integrationId,
      acceptTokenScope: true,
      repos: [],
    });
    assert.deepEqual(changes, ["POST"]);
    await f.mgr.detachIntegration({ ...identity, integrationId });
    assert.deepEqual(changes, ["POST", "DELETE"]);
  } finally {
    await f.dispose();
  }
});
test("integration mutation rejects protected and transitional machines", async () => {
  const f = fixture();
  const changes = integrationFixture(f);
  try {
    f.managed("removing");
    await assert.rejects(
      f.mgr.saveIntegration({
        ...identity,
        integrationId,
        repos: ["example/frontend"],
      }),
      /Wait for the machine/,
    );
    await assert.rejects(
      f.mgr.detachIntegration({ ...identity, integrationId }),
      /Wait for the machine/,
    );
    f.setRecords([f.resource()]);
    f.setCoreResource(null);
    await assert.rejects(
      f.mgr.saveIntegration({
        ...identity,
        integrationId,
        repos: ["example/frontend"],
      }),
      /ownership/,
    );
    assert.deepEqual(changes, []);
  } finally {
    await f.dispose();
  }
});
