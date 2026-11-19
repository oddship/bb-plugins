import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MachineExecutor } from "@get-bb/plugin-sdk";
import type { Transport } from "./executor.js";
import { remoteCommand } from "./remote-command.js";

function scan(
  host: string,
  port: number,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "ssh-keyscan",
      ["-T", "10", "-p", String(port), host],
      { signal, timeout: 15000, maxBuffer: 128000 },
      (error, stdout) => {
        if (error)
          reject(
            Error(
              "SSH key scan failed on the selected machine. Check OpenSSH installation and proxy access.",
            ),
          );
        else resolve(stdout);
      },
    );
  });
}

export function verifiedHostKeys(raw: string, fingerprint: string) {
  const matches = raw.split("\n").filter((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 3 || line.startsWith("#")) return false;
    return (
      "SHA256:" +
        createHash("sha256")
          .update(Buffer.from(fields[2]!, "base64"))
          .digest("base64")
          .replace(/=+$/, "") ===
      fingerprint.replace(/=+$/, "")
    );
  });
  if (!matches.length)
    throw Error(
      "SSH proxy fingerprint did not match. No SSH authentication was attempted.",
    );
  return matches.join("\n") + "\n";
}

// OpenSSH keeps native dependencies and private-key handling on the selected host.
export function hostSshExecutor(
  transport: Transport,
  name: string,
): MachineExecutor {
  return {
    async exec(request) {
      const signal = AbortSignal.any([
        request.signal,
        AbortSignal.timeout(request.timeoutMs),
      ]);
      signal.throwIfAborted();
      if (
        !/^[a-zA-Z0-9.:[\]-]+$/.test(transport.host) ||
        transport.host.startsWith("-")
      )
        throw Error("Invalid SSH proxy host.");
      const keys = verifiedHostKeys(
        await scan(transport.host, transport.port, signal),
        transport.fingerprint,
      );
      const directory = await mkdtemp(join(tmpdir(), "bb-dummie-ssh-"));
      try {
        const knownHosts = join(directory, "known_hosts");
        await writeFile(knownHosts, keys, { mode: 0o600 });
        const args = [
          "-F",
          "/dev/null",
          "-T",
          "-p",
          String(transport.port),
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=yes",
          "-o",
          "UpdateHostKeys=no",
          "-o",
          "GlobalKnownHostsFile=/dev/null",
          "-o",
          `UserKnownHostsFile=${knownHosts}`,
          "-o",
          "ConnectTimeout=15",
          "-o",
          "ServerAliveInterval=5",
          "-o",
          "ServerAliveCountMax=2",
          ...(transport.identityFile
            ? ["-i", transport.identityFile, "-o", "IdentitiesOnly=yes"]
            : []),
          `${name}@${transport.host}`,
        ];
        const remote = remoteCommand(request.command);
        signal.throwIfAborted();
        return await new Promise<{ exitCode: number }>((resolve, reject) => {
          const child = spawn("ssh", [...args, remote.command], {
            stdio: ["pipe", "pipe", "pipe"],
          });
          let cancellation: ReturnType<typeof spawn> | undefined;
          let killTimer: ReturnType<typeof setTimeout> | undefined;
          let settled = false;
          const finish = (error?: Error, exitCode = 255) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", abort);
            clearTimeout(killTimer);
            cancellation?.kill("SIGKILL");
            if (signal.aborted)
              reject(Error("SSH command cancelled or timed out."));
            else if (error) reject(error);
            else resolve({ exitCode });
          };
          const abort = () => {
            // Kill the remote process group before closing the original channel.
            cancellation = spawn("ssh", [...args, remote.cancel], {
              stdio: "ignore",
            });
            cancellation.on("error", () => {});
            killTimer = setTimeout(() => {
              child.kill("SIGKILL");
              finish();
            }, 2000);
          };
          signal.addEventListener("abort", abort, { once: true });
          child.on("error", () =>
            finish(
              Error(
                "OpenSSH could not start on the selected execution machine.",
              ),
            ),
          );
          child.stdout.on("data", (chunk) =>
            request.onOutput(chunk.toString("utf8")),
          );
          child.stderr.on("data", (chunk) =>
            request.onOutput(chunk.toString("utf8")),
          );
          child.stdin.on("error", () => {});
          child.on("close", (code) => finish(undefined, code ?? 255));
          child.stdin.end(request.stdin);
          if (signal.aborted) abort();
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
