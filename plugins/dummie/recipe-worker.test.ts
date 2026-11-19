import test from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createDummiePlugin } from "./server.js";
import { Recipes, setupScope } from "./recipes.js";
import type { Resource } from "./lifecycle.js";
test("plain recipe worker resumes its queue, runs the pinned script and never allocates or enrolls", async () => {
  const original = globalThis.fetch;
  let scripts = 0;
  let stops = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://remote.example.com");
    if (init?.method === "POST" && url.pathname.endsWith("/stop")) {
      stops++;
      return Response.json({});
    }
    assert.equal(init?.method, "GET");
    if (url.pathname.endsWith("/vms/hosts"))
      return Response.json({ items: [{ id: "client", hostname: "Host" }] });
    if (
      url.pathname.endsWith("/vms/kernels") ||
      url.pathname.endsWith("/vms/osimages")
    )
      return Response.json({ items: [] });
    if (url.pathname.endsWith("/me")) return Response.json({ id: "account" });
    return Response.json({
      id: "10000000-0000-4000-8000-000000000001",
      name: "quiet-otter-123456",
      created_by: "account",
      client_id: "client",
      status: "running",
      expires_at: "",
      vm_id: "guest",
    });
  };
  const { bb, harness } = createFakePluginHost({
    pluginId: "dummie",
    settings: {
      connection: "remote",
      remoteControlUrl: "https://remote.example.com",
      remoteToken: "fake-token",
    },
    sdk: { hosts: { list: async () => [] } },
    machineBootstrap: {
      async bootstrap() {
        throw Error("Plain recipes must not enroll BB");
      },
    },
  });
  try {
    const recipe = {
      ...(await new Recipes(bb.storage.kv).get("plain")),
      bootstrapScript: "echo pinned-script",
    };
    const resource: Resource = {
      version: 1,
      key: "plain-job",
      owner: "owner",
      endpoint: "https://remote.example.com",
      account: "account",
      name: "quiet-otter-123456",
      client: "client",
      vmId: "10000000-0000-4000-8000-000000000001",
      phase: "allocated",
      adopted: true,
      transport: {
        host: "proxy",
        port: 22,
        fingerprint: "pin",
        identityFile: "",
      },
    };
    const scope = setupScope(
      resource.endpoint,
      resource.account,
      resource.vmId!,
    );
    await bb.storage.kv.set("owner", "owner");
    await bb.storage.kv.set("recipe:job:" + scope, {
      resource,
      recipe,
      state: "pending",
      createdAt: Date.now(),
    });
    await createDummiePlugin(() => ({
      async exec(r) {
        if (r.stdin) {
          scripts++;
          assert.equal(r.stdin, "echo pinned-script");
          r.onOutput("setup worked");
        }
        return { exitCode: 0 };
      },
    }))(bb);
    const worker = harness.behavior.runService("recipe-bootstrap");
    try {
      for (let i = 0; i < 50; i++) {
        const raw = await bb.storage.kv.get<{ state: string }>(
          "recipe:job:" + scope,
        );
        if (raw?.state === "complete") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(
        (await bb.storage.kv.get<{ state: string }>("recipe:job:" + scope))!
          .state,
        "complete",
      );
      assert.equal(scripts, 1);
      assert.equal(
        (await bb.storage.kv.get<{ log: string }>("recipe:run:" + scope))!.log,
        "setup worked",
      );
    } finally {
      worker.controller.abort();
      await worker.done;
    }
    await bb.storage.kv.set("recipe:job:" + scope, {
      resource,
      recipe,
      state: "uncertain",
      createdAt: Date.now(),
    });
    await harness.behavior.callRpc("manager_action", {
      id: resource.vmId,
      expectedName: resource.name,
      action: "stop",
      confirmation: "",
    });
    assert.equal(
      stops,
      1,
      "An interrupted setup must not trap the user on a VM they cannot stop",
    );
  } finally {
    globalThis.fetch = original;
    await harness.lifecycle.dispose();
  }
});
