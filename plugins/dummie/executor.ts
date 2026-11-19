import { createRequire } from "node:module";
const { Client, utils } = createRequire(import.meta.url)(
  "ssh2",
) as typeof import("ssh2");
import { remoteCommand } from "./remote-command.js";
export { quote, remoteCommand } from "./remote-command.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { MachineExecutor } from "@get-bb/plugin-sdk";
export type Transport = {
  host: string;
  port: number;
  fingerprint: string;
  identityFile: string;
  executionHostId?: string;
};
export function sshExecutor(t: Transport, name: string): MachineExecutor {
  return {
    async exec(r) {
      r.signal.throwIfAborted();
      if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(t.fingerprint))
        throw Error("A verified SSH proxy SHA256 fingerprint is required.");
      const remote = remoteCommand(r.command);
      let privateKey = t.identityFile
        ? await readFile(t.identityFile)
        : undefined;
      if (privateKey) {
        const parsed = utils.parseKey(privateKey);
        if (
          parsed instanceof Error &&
          /encrypted|passphrase/i.test(parsed.message)
        ) {
          if (!process.env.SSH_AUTH_SOCK)
            throw Error(
              "Encrypted SSH identity requires an SSH agent visible to the BB server.",
            );
          privateKey = undefined;
        }
      }
      if (!privateKey && !process.env.SSH_AUTH_SOCK)
        throw Error(
          "Set an SSH identity file or provide an SSH agent to the BB server.",
        );
      return new Promise<{ exitCode: number }>((resolve, reject) => {
        const c = new Client();

        let settled = false;
        let cancellation: Error | undefined;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const finish = (error?: Error, code?: number) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearTimeout(killTimer);
          r.signal.removeEventListener("abort", abort);
          c.destroy();
          (error ?? cancellation)
            ? reject(error ?? cancellation)
            : resolve({ exitCode: code ?? 255 });
        };
        const cancel = (message: string) => {
          if (settled || cancellation) return;
          cancellation = Error(message);
          // ssh2.signal cannot send after stdin EOF. Use the same verified
          // connection and a separate exec channel to kill the unique group.
          try {
            c.exec(remote.cancel, (err, ch) => {
              if (err) return;
              ch.on("error", () => {});
              ch.resume();
              ch.stderr.resume();
              ch.end();
            });
          } catch {}
          killTimer = setTimeout(() => finish(cancellation), 1500);
        };
        const abort = () => cancel("SSH command cancelled.");
        const timer = setTimeout(
          () => cancel("SSH command timed out."),
          Math.max(1, r.timeoutMs),
        );
        r.signal.addEventListener("abort", abort, { once: true });
        c.on("error", () =>
          finish(
            Error(
              "SSH connection failed. Check proxy fingerprint, SSH key, account public key and tunnel.",
            ),
          ),
        );
        c.on("close", () => {
          if (!settled)
            finish(Error("SSH connection closed before exit status."));
        });
        c.on("ready", () => {
          if (r.signal.aborted) return abort();
          c.exec(remote.command, (err, ch) => {
            if (err) return finish(Error("SSH exec request failed."));

            // stdin is never logged. Core may send enrollment credentials here.
            ch.on("data", (data: Buffer) => r.onOutput(data.toString("utf8")));
            ch.stderr.on("data", (data: Buffer) =>
              r.onOutput(data.toString("utf8")),
            );
            ch.on("error", () => finish(Error("SSH channel failed.")));
            ch.on("close", (code: number | null) =>
              finish(undefined, code ?? 255),
            );
            ch.end(r.stdin);
          });
        });
        try {
          c.connect({
            host: t.host,
            port: t.port,
            username: name,
            ...(privateKey
              ? { privateKey }
              : { agent: process.env.SSH_AUTH_SOCK }),
            hostVerifier: (key: Buffer) =>
              "SHA256:" +
                createHash("sha256")
                  .update(key)
                  .digest("base64")
                  .replace(/=+$/, "") ===
              t.fingerprint,
            readyTimeout: Math.min(r.timeoutMs, 15000),
            keepaliveInterval: 5000,
            keepaliveCountMax: 2,
          });
        } catch {
          finish(Error("SSH configuration or private key is invalid."));
        }
      });
    },
  };
}
export const prerequisites = [
  "sh",
  "-lc",
  'set -eu; for x in node npm curl git make g++ python3 setsid; do command -v "$x" >/dev/null || { echo "Missing prerequisite: $x"; exit 1; }; done; node -e \'if(process.versions.bun || Number(process.versions.node.split(".")[0])<22)process.exit(1)\'; echo "BB prerequisites ready"',
];
