import test from "node:test";
import assert from "node:assert/strict";
import {
  createFakePluginHost,
  experimental_scanPublicSdkOnly,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";
import { fileURLToPath } from "node:url";
test("public SDK boundaries only", async () => {
  const scan = await experimental_scanPublicSdkOnly(
    fileURLToPath(new URL(".", import.meta.url)),
    {
      allow: [
        /^ssh2$/,
        /^react$/,
        /^@radix-ui\//,
        /^class-variance-authority$/,
        /^clsx$/,
        /^tailwind-merge$/,
      ],
    },
  );
  assert.deepEqual(scan.violations, []);
  assert.deepEqual(scan.privateDependencies, []);
});
test("real SDK harness validates persistent checkout and scratch compositions", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "dummie" });
  await plugin(bb);
  try {
    const p = harness.inspection.registrations.machineProviders.get("dummie")!;
    assert.equal(p.ephemeral, false);
    assert.equal(
      harness.inspection.registrations.environmentCompositions.get("dummie")!
        .environmentProviderId,
      "project-checkout",
    );
    const scratch =
      harness.inspection.registrations.environmentCompositions.get(
        "dummie-scratch",
      )!;
    assert.equal(scratch.machineProviderId, "dummie");
    assert.equal(scratch.environmentProviderId, "personal-workspace");
    assert.equal((await p.availability!()).status, "setup-required");
    const result = await harness.behavior.runCli(["catalog"]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr!, /personal access token/);
    assert.equal(
      (await harness.behavior.runCli(["remove", "host_any"])).exitCode,
      1,
    );
    assert.equal((await harness.behavior.runCli(["--help"])).exitCode, 0);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("bootstrap failure checkpoints VM and retry reuses allocation with the stable enrollment key", async () => {
  const { createDummiePlugin } = await import("./server.js");
  const original = globalThis.fetch;
  let vm: Record<string, unknown> | null = null;
  let posts = 0;
  let bootstrapCalls = 0;
  let checkpointed = false;
  let attached = false;
  let integrationConnected = false;
  let attachmentPosts = 0;
  const integrationId = "10000000-0000-4000-8000-000000000099";
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    let response: unknown;
    if (path.endsWith(`/integrations/${integrationId}`))
      response = {
        id: integrationId,
        name: "work",
        kind: "gitlab",
        connected: integrationConnected,
      };
    else if (
      path.endsWith(`/integrations/${integrationId}/vms/vm`) &&
      init?.method === "POST"
    ) {
      attached = true;
      attachmentPosts++;
      return new Response(null, { status: 204 });
    } else if (path.endsWith("/vms/vm/integrations"))
      response = { items: attached ? [{ id: integrationId }] : [] };
    else if (path.endsWith("/me")) response = { id: "account" };
    else if (init?.method === "POST" && path.endsWith("/vms")) {
      posts++;
      vm = {
        id: "vm",
        name: JSON.parse(String(init.body)).name,
        client_id: "00000000-0000-4000-8000-000000000001",
        created_by: "account",
        status: "running",
        vm_id: "guest",
        expires_at: "",
      };
      response = vm;
    } else if (path.endsWith("/vms"))
      response = { items: vm ? [vm] : [], total: vm ? 1 : 0 };
    else response = vm;
    return new Response(JSON.stringify(response), { status: 200 });
  };
  const { bb, harness } = createFakePluginHost({
    pluginId: "dummie",
    settings: {
      connection: "local",
      token: "test-secret",
      host: "00000000-0000-4000-8000-000000000001",
      kernel: "00000000-0000-4000-8000-000000000002",
      image: "00000000-0000-4000-8000-000000000003",
      sshFingerprint: "SHA256:" + "A".repeat(43),
    },
    machineBootstrap: {
      async bootstrap(request) {
        bootstrapCalls++;
        assert.equal(
          attached,
          true,
          "integration attaches before BB bootstrap",
        );
        assert.equal(checkpointed, true);
        assert.equal(request.key, "stable-key");
        if (bootstrapCalls === 1) throw Error("bootstrap unavailable");
        return { hostId: "host_test" };
      },
    },
  });
  try {
    await createDummiePlugin(() => ({
      async exec() {
        return { exitCode: 0 };
      },
    }))(bb);
    const provider =
      harness.inspection.registrations.machineProviders.get("dummie")!;
    const { Recipes } = await import("./recipes.js");
    const recipeStore = new Recipes(bb.storage.kv);
    const recipe = await recipeStore.save({
      ...(await recipeStore.get("bb-enrolled")),
      id: integrationId,
      builtin: false,
      integrations: [
        {
          origin: "http://127.0.0.1:1323",
          integrationId,
          name: "work",
          kind: "gitlab",
          acceptTokenScope: true,
        },
      ],
    });
    const context = {
      key: "stable-key",
      attempt: 1,
      inputs: { recipeId: recipe.id, recipeRevision: recipe.revision },
      report: { step: () => {}, log: () => {} },
      signal: AbortSignal.timeout(5000),
      checkpoint: async () => {
        checkpointed = true;
      },
    };
    const unavailable = await provider.create(context);
    assert.equal(unavailable.status, "failed");
    assert.equal(
      posts,
      0,
      "missing integration must fail before allocating a VM",
    );
    integrationConnected = true;
    const first = await provider.create(context);
    assert.equal(first.status, "failed");
    assert.equal(posts, 1);
    const { resourceSchema } = await import("./lifecycle.js");
    const partial = resourceSchema.parse(
      await bb.storage.kv.get("intent:stable-key"),
    );
    const cleanup = await provider.remove({
      hostId: "host_test",
      resource: partial,
      report: context.report,
      signal: context.signal,
    });
    assert.equal(cleanup.status, "failed");
    assert.ok(vm, "core failure cleanup must retain the unenrolled VM");
    const second = await provider.create({ ...context, attempt: 2 });
    assert.equal(second.status, "created");
    assert.equal(posts, 1);
    assert.equal(bootstrapCalls, 2);
    assert.equal(attachmentPosts, 1, "recovery reuses the existing attachment");
  } finally {
    globalThis.fetch = original;
    await harness.lifecycle.dispose();
  }
});

test("explicit recovery reuses an unenrolled VM, blocks live/double claims and releases old ownership without destroying compute", async () => {
  const { createDummiePlugin } = await import("./server.js");
  const { resourceSchema } = await import("./lifecycle.js");
  const { makeHostResponse } = await import("@get-bb/plugin-sdk/testing");
  const oldFetch = globalThis.fetch;
  let active = true;
  let posts = 0;
  let bootstraps = 0;
  let source: ReturnType<typeof resourceSchema.parse> | null = null;
  globalThis.fetch = async (input, init) => {
    if (init?.method === "POST") posts++;
    const path = new URL(String(input)).pathname;
    return new Response(
      JSON.stringify(
        path.endsWith("/me")
          ? { id: "account" }
          : {
              id: "vm",
              name: "owned",
              client_id: "client",
              created_by: "account",
              status: "running",
              vm_id: "guest",
              expires_at: "",
            },
      ),
      { status: 200 },
    );
  };
  const { bb, harness } = createFakePluginHost({
    pluginId: "dummie",
    settings: {
      connection: "local",
      token: "test",
      host: "00000000-0000-4000-8000-000000000001",
      kernel: "00000000-0000-4000-8000-000000000002",
      image: "00000000-0000-4000-8000-000000000003",
    },
    machineResource: async () => source,
    machineBootstrap: {
      async bootstrap() {
        bootstraps++;
        return { hostId: "host_new" };
      },
    },
  });
  try {
    await createDummiePlugin(() => ({
      async exec() {
        return { exitCode: 0 };
      },
    }))(bb);
    source = resourceSchema.parse({
      version: 1,
      key: "old",
      owner: await bb.storage.kv.get("owner"),
      endpoint: "http://127.0.0.1:1323",
      account: "account",
      name: "owned",
      client: "client",
      vmId: "vm",
      phase: "allocated",
      transport: {
        host: "localhost",
        port: 2224,
        fingerprint: "SHA256:" + "A".repeat(43),
        identityFile: "",
      },
    });
    await bb.storage.kv.set("intent:old", source);
    harness.inspection.sdk.stub("hosts.list", async () => [
      makeHostResponse({
        id: "host_old",
        machineProviderId: "dummie",
        status: active ? "connected" : "disconnected",
        lifecycle: {
          phase: "removing",
          suspendedAt: null,
          message: "failed",
          pendingLog: "",
          teardown: { status: "failed", attempt: 0 },
        },
      }),
    ]);
    const provider =
      harness.inspection.registrations.machineProviders.get("dummie")!;
    const context = {
      key: "new",
      attempt: 1,
      inputs: { recover: "old" },
      report: { step: () => {}, log: () => {} },
      signal: AbortSignal.timeout(5000),
      checkpoint: async () => {},
    };
    assert.equal((await provider.create(context)).status, "failed");
    assert.equal(posts, 0);
    active = false;
    const recovered = await provider.create(context);
    assert.equal(recovered.status, "created");
    assert.equal(posts, 0);
    assert.equal(bootstraps, 1);
    assert.equal(
      resourceSchema.parse(await bb.storage.kv.get("intent:old")).transferredTo,
      "new",
    );
    assert.equal(
      (
        await provider.remove({
          hostId: "host_old",
          resource: source,
          report: context.report,
          signal: context.signal,
        })
      ).status,
      "removed",
    );
    assert.equal(posts, 0);
    assert.equal(
      (await provider.create({ ...context, key: "another" })).status,
      "failed",
    );
    assert.equal(bootstraps, 1);
  } finally {
    globalThis.fetch = oldFetch;
    await harness.lifecycle.dispose();
  }
});

test("diagnostics serializes prepared allocations without exposing ownership or transport", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "dummie",
    settings: { connection: "local" },
  });
  await plugin(bb);
  try {
    await bb.storage.kv.set("intent:prepared-diagnostics", {
      version: 1,
      key: "prepared-diagnostics",
      owner: "private-owner",
      endpoint: "http://127.0.0.1:1323",
      account: "private-account",
      name: "bb-prepared",
      client: "host",
      phase: "prepared",
      transport: {
        host: "127.0.0.1",
        port: 2224,
        fingerprint: "private-pin",
        identityFile: "/private/key",
      },
    });
    const result = await harness.behavior.callRpc("diagnostics", null);
    assert.doesNotThrow(() => JSON.stringify(result));
    assert.deepEqual((result as any).intents, [
      {
        name: "bb-prepared",
        phase: "prepared",
        vmId: "",
        enrolled: false,
        transferred: false,
      },
    ]);
    assert.doesNotMatch(
      JSON.stringify(result),
      /private-owner|private-account|private-pin|private\/key/,
    );
  } finally {
    await harness.lifecycle.dispose();
  }
});
