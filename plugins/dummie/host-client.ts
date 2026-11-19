import { randomUUID } from "node:crypto";
import type { BbPluginApi, MachineExecutor } from "@get-bb/plugin-sdk";
import { Api, ApiError, TransientError, pause } from "./api.js";
import { hostContract } from "./host-contract.js";
import { sshExecutor, type Transport } from "./executor.js";

export function createHostRouting(bb: BbPluginApi, lifetime: AbortSignal) {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  return {
    api(origin: string, token: string, hostId: string) {
      return new Api(
        origin,
        token,
        !hostId
          ? undefined
          : async (path, signal, method, body) => {
              const result = await host.call(
                "request",
                hostContract.request.input.parse({
                  origin,
                  token,
                  path,
                  method,
                  ...(body === undefined ? {} : { body }),
                }),
                {
                  hostId,
                  signal: AbortSignal.any([signal, lifetime]),
                  timeoutMs: 25000,
                },
              );
              if (result.ok) return result.data;
              if (result.status !== undefined) {
                const error = new ApiError(result.status);
                error.message = result.message;
                throw error;
              }
              throw result.transient
                ? new TransientError(result.message)
                : Error(result.message);
            },
      );
    },
    executor(transport: Transport, name: string): MachineExecutor {
      const hostId = transport.executionHostId;
      if (!hostId) return sshExecutor(transport, name);
      return {
        async exec(request) {
          const id = randomUUID();
          const signal = AbortSignal.any([
            request.signal,
            lifetime,
            AbortSignal.timeout(request.timeoutMs + 10000),
          ]);
          signal.throwIfAborted();
          try {
            await host.call(
              "start",
              {
                id,
                transport,
                name,
                command: request.command,
                stdin: request.stdin,
                timeoutMs: request.timeoutMs,
              },
              { hostId, signal },
            );
            while (true) {
              const result = await host.call(
                "poll",
                { id },
                { hostId, signal },
              );
              if (result.output) request.onOutput(result.output);
              if (result.done) {
                if (result.error) throw Error(result.error);
                if (result.exitCode === undefined)
                  throw Error("SSH command ended without exit status.");
                return { exitCode: result.exitCode };
              }
              await pause(signal, 250);
            }
          } finally {
            // Independent cancellation still reaches the host after the caller aborts.
            await host
              .call(
                "cancel",
                { id },
                { hostId, signal: AbortSignal.timeout(5000), timeoutMs: 5000 },
              )
              .catch(() => {});
          }
        },
      };
    },
  };
}
