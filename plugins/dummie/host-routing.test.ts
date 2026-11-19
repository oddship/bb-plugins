import test from "node:test";
import assert from "node:assert/strict";
import {
  createFakePluginHost,
  makeHostResponse,
} from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { createDummiePlugin } from "./server.js";
import { createHostRouting } from "./host-client.js";
import { createHostEntry } from "./host.js";
import { verifiedHostKeys } from "./host-executor.js";
import { createHash } from "node:crypto";
import { ApiError, TransientError } from "./api.js";

const fingerprint = "SHA256:" + "A".repeat(43);
const transport = {
  host: "ssh.example.com",
  port: 22,
  fingerprint,
  identityFile: "/keys/work",
  executionHostId: "host_work",
};

test("SSH authentication accepts only the pinned public key from keyscan", () => {
  const key = Buffer.from("synthetic-public-key");
  const fingerprint = "SHA256:" + createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
  const line = `[ssh.example.com]:22 ssh-ed25519 ${key.toString("base64")}`;
  assert.equal(verifiedHostKeys(`# banner\n${line}\n`, fingerprint), line + "\n");
  assert.throws(() => verifiedHostKeys(line, "SHA256:" + "X".repeat(43)), /fingerprint did not match/);
  assert.throws(() => verifiedHostKeys("# no key", fingerprint), /fingerprint did not match/);
});

test("each remote selects its own machine and credentials without returning tokens", async () => {
  const calls: string[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "dummie",
    settings: {
      connection: "remote",
      remoteControlUrl: "https://work.example.com",
      remoteToken: "work-secret",
      remoteExecutionHostId: "host_work",
      remoteProfiles: JSON.stringify([
        {
          id: "public",
          label: "Public",
          controlUrl: "https://public.example.com",
          token: "public-secret",
          sshHost: "ssh.example.com",
          sshFingerprint: fingerprint,
          executionHostId: "host_public",
        },
      ]),
    },
    sdk: {
      hosts: {
        list: async () => [
          makeHostResponse({ id: "host_work", name: "Work laptop" }),
          makeHostResponse({ id: "host_public", name: "Public machine" }),
        ],
      },
    },
    experimental_callHostRpc: async ({ method, input, hostId }) => {
      assert.equal(method, "request");
      const request = input as { origin: string; path: string; token: string };
      calls.push(hostId);
      assert.equal(
        request.origin,
        hostId === "host_work"
          ? "https://work.example.com"
          : "https://public.example.com",
      );
      assert.equal(
        request.token,
        hostId === "host_work" ? "work-secret" : "public-secret",
      );
      return {
        ok: true,
        data: request.path === "/me" ? { id: "account" } : request.path === "/vms/pinned" ? {
          id: "pinned", name: "pinned-vm", client_id: "client", created_by: "account", status: "running", vm_id: "guest", expires_at: "",
        } : { items: [] },
      };
    },
  });
  await createDummiePlugin()(bb);
  try {
    await harness.behavior.callRpc("catalog", null);
    assert.ok([...calls].every((h) => h === "host_work"));
    calls.length = 0;
    await harness.behavior.callRpc("select_connection", {
      connection: "public",
    });
    await harness.behavior.callRpc("catalog", null);
    assert.ok(calls.length > 0 && [...calls].every((h) => h === "host_public"));
    const details = (await harness.behavior.callRpc("connection_details", {
      id: "public",
    })) as { executionHostId: string };
    assert.equal(details.executionHostId, "host_public");
    assert.ok(!JSON.stringify(details).includes("secret"));
    await bb.storage.kv.set("intent:pinned", {
      version: 1, key: "pinned", owner: await bb.storage.kv.get("owner"), endpoint: "https://work.example.com", account: "account", name: "pinned-vm", client: "client", vmId: "pinned", phase: "allocated", transport,
    });
    await harness.behavior.setSettings({ remoteExecutionHostId: "host_public" });
    calls.length = 0;
    await harness.behavior.callRpc("inspect", { key: "pinned" });
    assert.ok(calls.length > 0 && calls.every(h => h === "host_work"), "existing setup retains its original machine after remote and route changes");
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("host API errors retain lifecycle error types and never fall back locally", async () => {
  let mode = "404";
  const { bb, harness } = createFakePluginHost({
    pluginId: "dummie",
    experimental_callHostRpc: async () => {
      if (mode === "offline") throw Error("selected host offline");
      return {
        ok: false,
        ...(mode === "404" ? { status: 404 } : {}),
        transient: mode === "transient",
        message: "Controlled failure",
      };
    },
  });
  const routing = createHostRouting(bb, new AbortController().signal);
  try {
    const api = routing.api("https://work.example.com", "secret", "host_work");
    assert.equal(await api.get("vm", new AbortController().signal), null);
    await assert.rejects(api.account(new AbortController().signal), ApiError);
    mode = "transient";
    await assert.rejects(
      api.account(new AbortController().signal),
      TransientError,
    );
    mode = "offline";
    await assert.rejects(api.account(new AbortController().signal), /offline/);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("SSH relay returns incremental output and cancels commands on worker disposal", async () => {
  let cancelled = false;
  const entry = createHostEntry(() => ({
    exec: async (request) => {
      request.onOutput("started\n");
      await new Promise<void>((resolve) =>
        request.signal.addEventListener(
          "abort",
          () => {
            cancelled = true;
            resolve();
          },
          { once: true },
        ),
      );
      return { exitCode: 130 };
    },
  }));
  const host = experimental_createHostEntryHarness(entry);
  const id = "10000000-0000-4000-8000-000000000001";
  await host.experimental_call("start", {
    id,
    transport,
    name: "example-vm",
    command: ["sleep", "60"],
    stdin: "private enrollment",
    timeoutMs: 60000,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const first = await host.experimental_call("poll", { id });
  assert.equal(first.output, "started\n");
  assert.equal(first.done, false);
  assert.equal((await host.experimental_call("poll", { id })).output, "");
  await host.experimental_dispose();
  assert.equal(cancelled, true);
});

test("SSH client follows its pinned host and sends cancellation after caller abort", async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "dummie",
    experimental_callHostRpc: async ({ method, hostId }) => {
      assert.equal(hostId, "host_work");
      calls.push(method);
      if (method === "start") return { started: true };
      if (method === "cancel") return null;
      controller.abort();
      return { output: "", done: false };
    },
  });
  try {
    const executor = createHostRouting(
      bb,
      new AbortController().signal,
    ).executor(transport, "example-vm");
    await assert.rejects(
      executor.exec({
        command: ["true"],
        stdin: "",
        timeoutMs: 10000,
        signal: controller.signal,
        onOutput() {},
      }),
    );
    assert.deepEqual(calls, ["start", "poll", "cancel"]);
  } finally {
    await harness.lifecycle.dispose();
  }
});
