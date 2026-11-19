import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { remoteCommand } from "../executor.js";
const probe = `set -eu
[ "$(id -un)" = ubuntu ]
[ "$(sudo -n id -u)" = 0 ]
for tool in sh bash sudo setsid ps; do command -v "$tool" >/dev/null; done
for tool in node npm bun codex pi nvim go python3 gcc make; do
  if command -v "$tool" >/dev/null 2>&1; then echo "Unexpected project tool: $tool" >&2; exit 1; fi
done
IFS= read -r payload
[ "$payload" = "safe probe payload" ]
echo "Minimal guest shell and sudo ready"
`;
const command = remoteCommand(["sh", "-c", probe]).command;
const child = spawn(
  "docker",
  [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp",
    "-i",
    "bb-dummie-base:local",
    "sh",
    "-c",
    command,
  ],
  { stdio: ["pipe", "pipe", "pipe"] },
);
let output = "";
let error = "";
child.stdout.on("data", (d) => (output += d));
child.stderr.on("data", (d) => (error += d));
child.stdin.end("safe probe payload\n");
const code = await new Promise<number | null>((resolve, reject) => {
  child.on("error", reject);
  child.on("close", resolve);
});
assert.equal(code, 0, error);
assert.match(output, /Minimal guest shell and sudo ready/);
const result = {
  shell: "Debian /bin/sh",
  stdin: "passed",
  sudo: "passed",
  projectTools: "absent",
};
await writeFile(
  new URL("../artifacts/base-image-verification.json", import.meta.url),
  JSON.stringify(
    {
      image: "bb-dummie-base:local",
      ...result,
      exitCode: code,
    },
    null,
    2,
  ) + "\n",
);
console.log(result);
