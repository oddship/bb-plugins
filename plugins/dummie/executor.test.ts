import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createHash } from "node:crypto";
import ssh2 from "ssh2";
const { Server, utils } = ssh2;
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sshExecutor, quote } from "./executor.js";
async function serverFixture() {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const hostKey = keys.privateKey.export({ type: "pkcs1", format: "pem" });
  const client = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const dir = await mkdtemp(join(tmpdir(), "bb-dummie-ssh-"));
  const identityFile = join(dir, "identity");
  await writeFile(
    identityFile,
    client.privateKey.export({ type: "pkcs1", format: "pem" }),
    { mode: 0o600 },
  );
  const received = {
    stdin: "",
    command: "",
    signals: [] as string[],
    cancellations: 0,
  };
  let hung: ssh2.ServerChannel | undefined;
  const s = new Server({ hostKeys: [hostKey] }, (c) => {
    c.on("error", () => {});
    c.on("authentication", (ctx) => ctx.accept());
    c.on("ready", () =>
      c.on("session", (accept) => {
        const ses = accept();
        ses.on("exec", (accept, _reject, info) => {
          const stream = accept();
          if (info.command.includes("bb-dummie-cancel")) {
            received.cancellations++;
            hung?.exit(137);
            hung?.end();
            stream.exit(0);
            stream.end();
            return;
          }
          received.command = info.command;
          let input = "";
          stream.on("data", (d: Buffer) => (input += d.toString()));
          ses.on(
            "signal",
            (
              accept: (() => void) | undefined,
              _reject: unknown,
              info: { name: string },
            ) => {
              received.signals.push(info.name);
              accept?.();
              stream.exit(137);
              stream.end();
            },
          );
          stream.on("end", () => {
            received.stdin = input;
            if (info.command.includes("hang")) {
              hung = stream;
              return;
            }
            stream.write("public output");
            stream.exit(info.command.includes("nonzero") ? 7 : 0);
            stream.end();
          });
        });
      }),
    );
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const parsed = utils.parseKey(hostKey);
  if (parsed instanceof Error || Array.isArray(parsed)) throw Error("host key");
  const fingerprint =
    "SHA256:" +
    createHash("sha256")
      .update(parsed.getPublicSSH())
      .digest("base64")
      .replace(/=+$/, "");
  const transport = {
    host: "127.0.0.1",
    port: (s.address() as { port: number }).port,
    fingerprint,
    identityFile,
  };
  return {
    transport,
    received,
    close: async () => {
      await new Promise<void>((r) => s.close(() => r()));
      await rm(dir, { recursive: true });
    },
  };
}
test("SSH preserves stdin privacy, exit status and output with a real protocol server", async () => {
  const f = await serverFixture();
  try {
    let out = "";
    const r = await sshExecutor(f.transport, "owned-vm").exec({
      command: ["nonzero", "a'b"],
      stdin: "private enrollment value",
      signal: AbortSignal.timeout(5000),
      timeoutMs: 3000,
      onOutput: (c) => (out += c),
    });
    assert.equal(r.exitCode, 7);
    assert.equal(f.received.stdin, "private enrollment value");
    assert.ok(f.received.command.includes("nonzero"));
    assert.equal(out, "public output");
    assert.ok(!out.includes("private"));
  } finally {
    await f.close();
  }
});
test("SSH refuses changed host identity", async () => {
  const f = await serverFixture();
  try {
    await assert.rejects(
      sshExecutor(
        { ...f.transport, fingerprint: "SHA256:" + "A".repeat(43) },
        "vm",
      ).exec({
        command: ["true"],
        stdin: "",
        signal: AbortSignal.timeout(5000),
        timeoutMs: 3000,
        onOutput: () => {},
      }),
      /SSH connection failed/,
    );
  } finally {
    await f.close();
  }
});
test("SSH timeout and cancellation terminate hung commands", async () => {
  const f = await serverFixture();
  try {
    const exec = sshExecutor(f.transport, "vm");
    await assert.rejects(
      exec.exec({
        command: ["hang"],
        stdin: "",
        signal: AbortSignal.timeout(5000),
        timeoutMs: 1500,
        onOutput: () => {},
      }),
      /timed out/,
    );
    const controller = new AbortController();
    const pending = exec.exec({
      command: ["hang"],
      stdin: "",
      signal: controller.signal,
      timeoutMs: 5000,
      onOutput: () => {},
    });
    setTimeout(() => controller.abort(), 1000);
    await assert.rejects(pending, /cancelled/);
    assert.equal(f.received.cancellations, 2);
  } finally {
    await f.close();
  }
});
test("argv quoting is literal and rejects NUL", () => {
  assert.equal(quote("a'b"), "'a'\\''b'");
  assert.throws(() => quote("\0"));
});

test("remote wrapper forwards stdin, preserves status and cancellation kills a real process group", async () => {
  const { remoteCommand } = await import("./executor.js");
  const { spawn } = await import("node:child_process");
  const run = remoteCommand(["sh", "-c", "cat; exit 7"]);
  let output = "";
  const child = spawn("sh", ["-c", run.command], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => (output += d));
  child.stdin.end("private stdin\n");
  const code = await new Promise<number | null>((r) => child.on("close", r));
  assert.equal(code, 7);
  assert.equal(output, "private stdin\n");
  const hang = remoteCommand(["sh", "-c", "sleep 30 & wait"]);
  const process = spawn("sh", ["-c", hang.command], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  process.stdin.end();
  const closed = new Promise<number | null>((r) => process.on("close", r));
  const killer = spawn("sh", ["-c", hang.cancel], { stdio: "ignore" });
  assert.equal(
    await new Promise<number | null>((r) => killer.on("close", r)),
    0,
  );
  assert.equal(await closed, 137);
});
