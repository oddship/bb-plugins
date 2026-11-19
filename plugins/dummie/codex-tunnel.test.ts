import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

test(
  "Codex account tunnel closes its SSH process when the BB machine is removed",
  { timeout: 25000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "bb-codex-tunnel-"));
    try {
      const counter = join(root, "counter");
      const closed = join(root, "closed");
      const fakeBb = join(root, "bb.cjs");
      const fakeSsh = join(root, "ssh");
      await writeFile(
        fakeBb,
        `const fs = require('node:fs');
const counter = ${JSON.stringify(counter)};
if (!fs.existsSync(counter)) {
 fs.writeFileSync(counter, 'active');
 console.log(JSON.stringify({ lifecycle: { phase: 'active' } }));
} else {
 console.log(JSON.stringify({ error: { code: 'host_not_found', message: 'Host not found' } }));
 process.exitCode = 1;
}`,
      );
      await writeFile(
        fakeSsh,
        `#!${process.execPath}
const fs = require('node:fs');
process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(closed)}, 'closed'); process.exit(0); });
setInterval(() => {}, 1000);
`,
        { mode: 0o700 },
      );
      const child = spawn(
        "python3",
        [
          fileURLToPath(
            new URL("./scripts/keep-codex-tunnel.py", import.meta.url),
          ),
          "--node",
          process.execPath,
          "--bb",
          fakeBb,
          "--ssh",
          fakeSsh,
          "--host",
          "host_test",
          "--vm",
          "calm-otter-123456",
          "--proxy",
          "localhost",
          "--identity",
          join(root, "unused-key"),
          "--known-hosts",
          join(root, "unused-hosts"),
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout.on("data", (data) => (output += String(data)));
      child.stderr.on("data", (data) => (output += String(data)));
      const exitCode = await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", resolve);
      });
      assert.equal(exitCode, 0, output);
      assert.match(output, /VM removed; closing/);
      assert.equal(await readFile(closed, "utf8"), "closed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
