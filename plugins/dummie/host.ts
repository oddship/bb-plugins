import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { Api, ApiError, TransientError } from "./api.js";
import { hostContract } from "./host-contract.js";
import { z } from "zod";
import { hostSshExecutor } from "./host-executor.js";

type Job = {
  controller: AbortController;
  output: string;
  done: boolean;
  exitCode?: number;
  error?: string;
  seen: number;
  completion: Promise<void>;
};

// Jobs live only in this host worker. Stdin and private keys are never returned.
export function createHostEntry(executorFactory = hostSshExecutor) {
  const jobs = new Map<string, Job>();
  const sweep = setInterval(() => {
    for (const [id, job] of jobs) {
      if (Date.now() - job.seen < 45000) continue;
      job.controller.abort();
      if (job.done) jobs.delete(id);
    }
  }, 10000);
  sweep.unref();
  return experimental_defineHostEntry({
    contract: hostContract,
    handlers: {
      request: async (input, context) => {
        try {
          const data = await new Api(input.origin, input.token).request(
            input.path,
            context.signal,
            input.method,
            input.body,
          );
          return { ok: true as const, data: z.json().parse(data) };
        } catch (error) {
          context.signal.throwIfAborted();
          return {
            ok: false as const,
            ...(error instanceof ApiError ? { status: error.status } : {}),
            transient: error instanceof TransientError,
            message:
              error instanceof ApiError || error instanceof TransientError
                ? error.message
                : "Dummie host request failed.",
          };
        }
      },
      start: (input, context) => {
        if (jobs.has(input.id)) return { started: true as const };
        if (jobs.size >= 32)
          throw Error("Too many active Dummie SSH commands on this machine.");
        const controller = new AbortController();
        const lease = context.experimental_retainWorker();
        const job: Job = {
          controller,
          output: "",
          done: false,
          seen: Date.now(),
          completion: Promise.resolve(),
        };
        jobs.set(input.id, job);
        job.completion = Promise.resolve()
          .then(async () => {
            const result = await executorFactory(
              input.transport,
              input.name,
            ).exec({
              command: input.command,
              stdin: input.stdin,
              timeoutMs: input.timeoutMs,
              signal: AbortSignal.any([
                controller.signal,
                context.lifecycle.signal,
              ]),
              onOutput: (chunk) => {
                if (
                  Buffer.byteLength(job.output) + Buffer.byteLength(chunk) >
                  2 * 1024 * 1024
                ) {
                  job.error =
                    "SSH output exceeded the relay buffer. Command cancelled.";
                  controller.abort();
                } else job.output += chunk;
              },
            });
            job.exitCode = result.exitCode;
          })
          .catch(() => {
            job.error ??=
              "SSH command failed or was cancelled on the selected execution machine. Check its SSH key, proxy and fingerprint.";
          })
          .finally(async () => {
            job.done = true;
            await lease.dispose();
          });
        return { started: true as const };
      },
      poll: ({ id }) => {
        const job = jobs.get(id);
        if (!job)
          throw Error(
            "SSH relay lost this command. Check the VM before retrying.",
          );
        job.seen = Date.now();
        const output = job.output;
        job.output = "";
        return {
          output,
          done: job.done,
          ...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
          ...(job.error ? { error: job.error } : {}),
        };
      },
      cancel: async ({ id }) => {
        const job = jobs.get(id);
        if (job) {
          job.controller.abort();
          await job.completion;
          jobs.delete(id);
        }
        return null;
      },
    },
    dispose: async () => {
      clearInterval(sweep);
      for (const job of jobs.values()) job.controller.abort();
      await Promise.all([...jobs.values()].map((j) => j.completion));
      jobs.clear();
    },
  });
}
export default createHostEntry();
