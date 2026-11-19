import test from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { Api, TransientError, type VM } from "./api.js";
import { NetworkAccess, networkMethods, type NetworkScope } from "./network.js";
const vmId = "10000000-0000-4000-8000-000000000001";
class Fake extends Api {
  targets: any[] = [];
  blocks: any[] = [
    {
      kind: "lookup",
      domain: "www.google.com",
      attempts: 1,
      last_seen: new Date().toISOString(),
    },
  ];
  posts = 0;
  deletes = 0;
  loseReply = false;
  noCommit = false;
  constructor() {
    super("https://remote.example.com", "secret");
  }
  override async request(
    path: string,
    signal: AbortSignal,
    method = "GET",
    body?: unknown,
  ): Promise<unknown> {
    signal.throwIfAborted();
    if (path.includes("/denied"))
      return {
        available: true,
        items: this.blocks,
        recording: { packets: true, lookups: true },
      };
    if (method === "GET") return { items: this.targets };
    if (method === "POST") {
      this.posts++;
      const b = body as any;
      assert.equal(b.kind, "domain");
      assert.equal(b.transport, "tcp");
      assert.ok([300, 3600, 86400].includes(b.ttl_seconds));
      if (!this.noCommit)
        this.targets.push({
          ...b,
          id: "target-" + this.posts,
          expires_at: new Date(Date.now() + b.ttl_seconds * 1000).toISOString(),
        });
      if (this.loseReply || this.noCommit)
        throw new TransientError("reply lost");
      return this.targets.at(-1);
    }
    this.deletes++;
    this.targets = this.targets.filter((t) => !path.endsWith("/" + t.id));
    return null;
  }
}
function scope(api: Fake): NetworkScope {
  return {
    api,
    account: "account",
    canManage: true,
    signal: AbortSignal.timeout(5000),
    vm: {
      id: vmId,
      name: "sample-vm",
      client_id: "client",
      created_by: "account",
      status: "running",
      vm_id: "guest",
      expires_at: "",
    } as VM,
  };
}
test("on-demand web access is scoped, temporary, idempotent and can be removed without touching other rules", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "dummie" });
  try {
    const api = new Fake(),
      s = scope(api),
      access = new NetworkAccess(bb.storage.kv);
    api.targets.push({
      id: "keep",
      kind: "domain",
      destination: "registry.npmjs.org",
      ports: "443",
      note: "existing",
    });
    const first = await access.status(s);
    const input = {
      selector: { vmId },
      expectedName: s.vm.name,
      blockKey: first.blocks[0]!.key,
      ttlSeconds: 300 as const,
      ports: "443" as const,
    };
    await access.allow(s, input);
    await access.allow(s, input);
    assert.equal(api.posts, 1);
    const next = await access.status(s);
    assert.equal(next.blocks[0]!.allowed, true);
    assert.equal(next.grants[0]!.destination, "www.google.com");
    assert.equal(next.grants[0]!.ports, "443");
    await access.revoke(s, {
      selector: { vmId },
      expectedName: s.vm.name,
      grantId: next.grants[0]!.id,
    });
    assert.equal(api.deletes, 1);
    assert.equal(api.targets[0]!.id, "keep");
    assert.equal((await access.status(s)).blocks[0]!.allowed, false);
    assert.equal((await access.status(s)).grants.length, 0);
  } finally {
    await harness.lifecycle.dispose();
  }
});
test("unobserved destinations, foreign machines, changed names, service lookups and raw IPs cannot be allowed", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "dummie" });
  try {
    const api = new Fake(),
      s = scope(api),
      access = new NetworkAccess(bb.storage.kv);
    api.blocks.push(
      {
        kind: "lookup",
        domain: "_https._tcp.google.com",
        attempts: 1,
        last_seen: new Date().toISOString(),
      },
      {
        kind: "packet",
        address: "1.2.3.4",
        proto: "tcp",
        port: 443,
        attempts: 1,
        last_seen: new Date().toISOString(),
      },
    );
    const state = await access.status(s);
    const input = {
      selector: { vmId },
      expectedName: s.vm.name,
      blockKey: state.blocks[0]!.key,
      ttlSeconds: 3600 as const,
      ports: "443" as const,
    };
    await assert.rejects(
      access.allow({ ...s, canManage: false }, input),
      /access is unavailable/,
    );
    await assert.rejects(
      access.allow(s, { ...input, expectedName: "other-vm" }),
      /Machine changed/,
    );
    await assert.rejects(
      access.allow(s, { ...input, blockKey: "0".repeat(64) }),
      /no longer/,
    );
    for (const b of state.blocks.filter((b) => !b.canAllow))
      await assert.rejects(
        access.allow(s, { ...input, blockKey: b.key }),
        /no longer/,
      );
    await assert.rejects(
      access.status({ ...s, account: "another-account" }),
      /does not belong/,
    );
    assert.equal(api.posts, 0);
    assert.equal(
      networkMethods.network_allow.input.safeParse({ ...input, ttlSeconds: 0 })
        .success,
      false,
    );
    assert.equal(
      networkMethods.network_allow.input.safeParse({
        ...input,
        ports: "1:65535",
      }).success,
      false,
    );
  } finally {
    await harness.lifecycle.dispose();
  }
});
test("lost replies reconcile committed access and unconfirmed writes cannot be reposted", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "dummie" });
  try {
    const api = new Fake(),
      s = scope(api),
      access = new NetworkAccess(bb.storage.kv);
    const input = {
      selector: { vmId },
      expectedName: s.vm.name,
      blockKey: (await access.status(s)).blocks[0]!.key,
      ttlSeconds: 300 as const,
      ports: "443" as const,
    };
    api.loseReply = true;
    await access.allow(s, input);
    assert.equal(api.posts, 1);
    assert.equal((await access.status(s)).grants.length, 1);
    const second = scope(new Fake());
    second.vm = { ...s.vm, id: "another-vm" };
    (second.api as Fake).noCommit = true;
    await assert.rejects(access.allow(second, input), /not yet confirmed/);
    await assert.rejects(access.allow(second, input), /earlier access request/);
    assert.equal((second.api as Fake).posts, 1);
    await assert.rejects(
      access.revoke(second, {
        selector: { vmId },
        expectedName: s.vm.name,
        grantId: (await access.status(s)).grants[0]!.id,
      }),
      /not created here/,
    );
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("a rule without the requested expiry is rolled back", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "dummie" });
  try {
    const api = new Fake(),
      s = scope(api),
      access = new NetworkAccess(bb.storage.kv);
    const original = api.request.bind(api);
    api.request = async (...args) => {
      const result = await original(...args);
      if (args[2] === "POST") api.targets.at(-1).expires_at = "";
      return result;
    };
    const b = (await access.status(s)).blocks[0]!;
    await assert.rejects(
      access.allow(s, {
        selector: { vmId },
        expectedName: s.vm.name,
        blockKey: b.key,
        ttlSeconds: 300,
        ports: "443",
      }),
      /new allowance was removed/,
    );
    assert.equal(api.posts, 1);
    assert.equal(api.deletes, 1);
    assert.equal(api.targets.length, 0);
  } finally {
    await harness.lifecycle.dispose();
  }
});
