import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const transportSchema = z.object({
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}=?$/),
  identityFile: z.string().max(4096),
  executionHostId: z.string().optional(),
});
export const hostContract = defineRpcContract({
  request: {
    input: z
      .object({
        origin: z.string().url().max(2048),
        token: z.string().max(8192),
        path: z.string().startsWith("/").max(4096),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
        body: z.json().optional(),
      })
      .strict(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), data: z.json() }),
      z.object({
        ok: z.literal(false),
        status: z.number().optional(),
        transient: z.boolean(),
        message: z.string().max(2000),
      }),
    ]),
  },
  start: {
    input: z
      .object({
        id: z.string().uuid(),
        transport: transportSchema,
        name: z
          .string()
          .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
          .max(52),
        command: z.array(z.string().max(1000000)).min(1).max(100),
        stdin: z.string().max(16 * 1024 * 1024),
        timeoutMs: z.number().int().min(1).max(3600000),
      })
      .strict(),
    output: z.object({ started: z.literal(true) }),
  },
  poll: {
    input: z.object({ id: z.string().uuid() }).strict(),
    output: z.object({
      output: z.string().max(2 * 1024 * 1024),
      done: z.boolean(),
      exitCode: z.number().optional(),
      error: z.string().optional(),
    }),
  },
  cancel: {
    input: z.object({ id: z.string().uuid() }).strict(),
    output: z.null(),
  },
});
