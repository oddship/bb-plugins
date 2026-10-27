import {
  defineRpcContract,
  type ExperimentalHostSignals,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
export const originSchema = z
  .string()
  .url()
  .max(512)
  .refine((value) => {
    try {
      const u = new URL(value);
      return (
        ["http:", "https:"].includes(u.protocol) &&
        u.origin === value &&
        !u.username &&
        !u.password
      );
    } catch {
      return false;
    }
  }, "An exact HTTP(S) origin is required");
export const selectionSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (p) =>
          !p.startsWith("/") &&
          !p.includes("\\") &&
          !p.split("/").includes(".."),
        "Use a workspace-relative path",
      ),
    l1: z.number().int().min(1),
    l2: z.number().int().min(1),
    text: z.string().max(24000),
  })
  .strict()
  .refine((s) => s.l2 >= s.l1, "Invalid line range");
export const sessionSchema = z.object({
  key: z.string(),
  threadId: z.string(),
  root: z.string(),
  port: z.number().int(),
  url: z.string(),
  pid: z.number().int(),
  lastUsed: z.number(),
  fileCount: z.number().int().nonnegative().nullable().default(null),
});
const identity = { threadId: z.string().min(1), origin: originSchema };
export const hostContract = defineRpcContract({
  ensure: {
    input: z
      .object({
        key: z.string(),
        threadId: z.string(),
        root: z.string(),
        origin: originSchema,
        tunnel: z
          .object({ label: z.string(), baseDomain: z.string() })
          .nullable(),
        binaryPath: z.string(),
      })
      .strict(),
    output: sessionSchema,
  },
  stop: {
    input: z.object({ threadId: z.string() }).strict(),
    output: z.object({ stopped: z.number() }),
  },
  status: {
    input: z.null(),
    output: z.object({ sessions: z.array(sessionSchema) }),
  },
});
export const hostSignals = {
  ports: { payload: z.object({ ports: z.array(z.number().int()) }) },
} satisfies ExperimentalHostSignals;
export const rpcContract = defineRpcContract({
  open: {
    input: z.object({ ...identity, remote: z.boolean() }).strict(),
    output: sessionSchema.extend({
      environmentId: z.string(),
      hostId: z.string(),
    }),
  },
  stop: {
    input: z.object({ threadId: z.string() }).strict(),
    output: z.object({ stopped: z.number() }),
  },
  feedback: {
    input: z
      .object({
        threadId: z.string(),
        environmentId: z.string(),
        requestId: z.string().uuid(),
        selection: selectionSchema,
        instruction: z.string().trim().min(1).max(12000),
      })
      .strict(),
    output: z.object({ sent: z.boolean() }),
  },
});
export type Selection = z.infer<typeof selectionSchema>;
