import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const processSchema = z.object({
  pid: z.number().int(),
  ppid: z.number().int(),
  name: z.string(),
  cpu: z.number().nonnegative(),
  rss: z.number().nonnegative(),
});
export const threadSchema = z.object({
  id: z.string(),
  cpu: z.number().nonnegative(),
  rss: z.number().nonnegative(),
  count: z.number().int().nonnegative(),
  processes: z.array(processSchema),
});
export const sampleSchema = z.object({
  at: z.number(),
  intervalMs: z.number(),
  cores: z.number(),
  cpu: z.number().nullable(),
  totalMemory: z.number(),
  availableMemory: z.number(),
  scanned: z.number(),
  unreadable: z.number(),
  unattributed: z.number(),
  truncated: z.boolean(),
  threads: z.array(threadSchema),
});
export const hostContract = defineRpcContract({
  sample: {
    input: z
      .object({
        sessionOwners: z
          .array(
            z
              .object({
                threadId: z.string().regex(/^thr_[a-z0-9]{8,}$/),
                sessionId: z
                  .string()
                  .regex(
                    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
                  ),
              })
              .strict(),
          )
          .max(8000)
          .default([]),
      })
      .strict(),
    output: sampleSchema,
  },
});
export type SessionOwner = { threadId: string; sessionId: string };
export const viewSchema = sampleSchema.extend({
  hostId: z.string(),
  hostName: z.string(),
  threads: z.array(
    threadSchema.extend({
      title: z.string(),
      projectId: z.string().nullable(),
      status: z.string(),
    }),
  ),
});
export const rpcContract = defineRpcContract({
  machines: {
    input: z.null(),
    output: z.array(
      z.object({ id: z.string(), name: z.string(), status: z.string() }),
    ),
  },
  snapshot: {
    input: z.object({ hostId: z.string().min(1).max(200) }).strict(),
    output: viewSchema,
  },
});
export type Sample = z.infer<typeof sampleSchema>;
export type View = z.infer<typeof viewSchema>;
export type ProcessRow = z.infer<typeof processSchema>;
