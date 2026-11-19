import test from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { rpcContract } from "./server.js";
import type { z } from "zod";

const input = (
  label: string,
  controlUrl: string,
  token = "secret-" + label,
) => ({
  label,
  controlUrl,
  token,
  sshHost: "ssh.example.com",
  sshPort: 22,
  sshFingerprint: "SHA256:" + "A".repeat(43),
  identityFile: "",
});

test("named remotes survive reload, keep credentials private and route pinned machines independently of selection", async () => {
  let { bb, harness } = createFakePluginHost({ pluginId: "dummie" });
  const original = globalThis.fetch;
  const requests: Array<{ origin: string; authorization: string | null }> = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    requests.push({
      origin: u.origin,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return Response.json(
      u.pathname.endsWith("/me") ? { id: "account" } : { items: [], total: 0 },
    );
  };
  const call = async <K extends keyof typeof rpcContract>(
    method: K,
    input: unknown,
  ) =>
    (await harness.behavior.callRpc(method, input)) as z.infer<
      (typeof rpcContract)[K]["output"]
    >;
  await plugin(bb);
  try {
    assert.deepEqual((await call("connections", null)).profiles, []);
    const a = await call(
      "save_connection",
      input("Work", "https://work.example.com"),
    );
    const b = await call(
      "save_connection",
      input("Personal", "https://personal.example.com"),
    );
    await call("select_connection", { connection: b.id });
    const listing = await call("connections", null);
    assert.equal(listing.active, b.id);
    assert.deepEqual(
      listing.profiles.map((p: { label: string }) => p.label),
      ["Work", "Personal"],
    );
    assert.ok(!JSON.stringify(listing).includes("secret-"));
    const details = await call("connection_details", { id: a.id });
    assert.ok(!("token" in details));
    await call("save_connection", {
      ...input("Office", "https://work.example.com", ""),
      id: a.id,
    });
    await bb.storage.kv.set("intent:pinned", {
      version: 1,
      key: "pinned",
      owner: await bb.storage.kv.get("owner"),
      endpoint: "https://work.example.com",
      account: "account",
      name: "calm-otter-123456",
      client: "client",
      phase: "prepared",
      transport: {
        host: "ssh.example.com",
        port: 22,
        fingerprint: "SHA256:" + "A".repeat(43),
        identityFile: "",
      },
    });
    ({ bb, harness } = await harness.lifecycle.reload(plugin));
    await call("inspect", { key: "pinned" });
    assert.ok(requests.length > 0);
    assert.ok(requests.every((r) => r.origin === "https://work.example.com"));
    assert.ok(requests.every((r) => r.authorization === "Bearer secret-Work"));
    assert.equal((await call("connections", null)).active, b.id);
    assert.equal(
      (await call("connection_details", { id: a.id })).label,
      "Office",
    );
    await assert.rejects(
      call("save_connection", {
        ...input("Changed", "https://wrong.example.com"),
        id: a.id,
      }),
      /different address/,
    );
    await assert.rejects(
      call("save_connection", input("Duplicate", "https://work.example.com/")),
      /already saved/,
    );
    await assert.rejects(
      call("save_connection", input("Local", "http://localhost:1323")),
      /HTTPS/,
    );
    await assert.rejects(
      call("select_connection", { connection: "missing" }),
      /no longer configured/,
    );
    await assert.rejects(
      call("select_connection", { connection: "local" }),
      /remote Dummie/,
    );
  } finally {
    globalThis.fetch = original;
    await harness.lifecycle.dispose();
  }
});

test("legacy remote remains selectable with its credentials and defaults", async () => {
  let { bb, harness } = createFakePluginHost({
    pluginId: "dummie",
    settings: {
      connection: "remote",
      remoteToken: "legacy-secret",
      remoteControlUrl: "https://dummie.example.com",
      remoteSshHost: "ssh.example.com",
      remoteCpus: 3,
      remoteSshFingerprint: "SHA256:" + "A".repeat(43),
    },
  });
  const call = async <K extends keyof typeof rpcContract>(
    method: K,
    input: unknown,
  ) =>
    (await harness.behavior.callRpc(method, input)) as z.infer<
      (typeof rpcContract)[K]["output"]
    >;
  await plugin(bb);
  try {
    const profiles = (await call("connections", null)).profiles;
    assert.equal(profiles[0].id, "remote");
    const details = await call("connection_details", { id: "remote" });
    assert.equal(details.cpus, 3);
    await call("save_connection", {
      ...input("Example Dummie", details.controlUrl, ""),
      id: "remote",
    });
    assert.equal(
      (await call("connections", null)).profiles[0].label,
      "Example Dummie",
    );
    assert.equal((await call("connection_details", { id: "remote" })).cpus, 3);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("first remote can use Example Dummie and machine defaults stay with each remote", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "dummie" });
  const original = globalThis.fetch;
  const choiceId = "00000000-0000-4000-8000-000000000001";
  globalThis.fetch = async (url) =>
    Response.json(
      String(url).endsWith("/me")
        ? { id: "account" }
        : { items: [{ id: choiceId }] },
    );
  await plugin(bb);
  try {
    const a = rpcContract.save_connection.output.parse(
      await harness.behavior.callRpc(
        "save_connection",
        input("Tech", "https://dummie.example.com"),
      ),
    );
    const b = rpcContract.save_connection.output.parse(
      await harness.behavior.callRpc(
        "save_connection",
        input("Other", "https://other.example.com"),
      ),
    );
    await harness.behavior.callRpc("select_connection", { connection: a.id });
    await harness.behavior.callRpc("manager_defaults", {
      host: choiceId,
      kernel: choiceId,
      image: choiceId,
      cpus: 4,
      memoryMiB: 4096,
      disk: "8G",
      targets: [],
    });
    await harness.behavior.callRpc("select_connection", { connection: b.id });
    const details = async (id: string) =>
      rpcContract.connection_details.output.parse(
        await harness.behavior.callRpc("connection_details", { id }),
      );
    assert.equal((await details(a.id)).cpus, 4);
    assert.equal((await details(a.id)).memory, 4096);
    assert.equal((await details(b.id)).cpus, 1);
    assert.equal((await details(b.id)).host, "");
  } finally {
    globalThis.fetch = original;
    await harness.lifecycle.dispose();
  }
});
