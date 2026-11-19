import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
const identifier = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (v) => !v.startsWith("-") && !/[\x00-\x1f]/.test(v),
    "Use a name or ID, not a CLI option.",
  );
const selection = {
  context: identifier.optional(),
  hostId: identifier.optional(),
};
const source = { ...selection, team: identifier, source: identifier };
export const requestSchema = z
  .discriminatedUnion("action", [
    z.object({ action: z.literal("teams"), ...selection }).strict(),
    z
      .object({ action: z.literal("sources"), ...selection, team: identifier })
      .strict(),
    z.object({ action: z.literal("schema"), ...source }).strict(),
    z.object({ action: z.literal("collections"), ...source }).strict(),
    z
      .object({
        action: z.literal("query"),
        ...source,
        query: z
          .string()
          .max(12000)
          .refine((v) => !v.includes("\0")),
        since: z
          .string()
          .regex(/^[1-9]\d{0,3}[smhd]$/)
          .default("15m"),
        from: z.iso.datetime({ offset: true }).optional(),
        to: z.iso.datetime({ offset: true }).optional(),
        limit: z.number().int().min(1).max(500).default(100),
      })
      .strict(),
  ])
  .superRefine((i, c) => {
    if (
      i.action === "query" &&
      (Boolean(i.from) !== Boolean(i.to) ||
        (i.from && i.to && Date.parse(i.from) >= Date.parse(i.to)))
    )
      c.addIssue({
        code: "custom",
        message: "Supply both from and to, with from earlier than to.",
      });
  });
// Native tool protocols require an object at the schema root. Conditional
// requirements are enforced by requestSchema at the execution boundary.
export const toolInputSchema = z
  .object({
    action: z.enum(["teams", "sources", "schema", "collections", "query"]),
    ...selection,
    team: identifier.optional(),
    source: identifier.optional(),
    query: z.string().max(12000).optional(),
    since: z.string().max(20).optional(),
    from: z.string().max(100).optional(),
    to: z.string().max(100).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();
export type Request = z.infer<typeof requestSchema>;
export const rowSchema = z.object({
  id: z.string(),
  name: z.string(),
  detail: z.string(),
});
export const resultSchema = z.object({
  rows: z.array(rowSchema).max(1000),
  logs: z.array(z.record(z.string(), z.unknown())).max(500),
  count: z.number().int().nonnegative(),
  stats: z.record(z.string(), z.unknown()),
  generatedSql: z.string(),
  truncated: z.boolean(),
});
export type Result = z.infer<typeof resultSchema>;
const machineSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
});
export const rpcContract = defineRpcContract({
  connection: {
    input: z.null(),
    output: z.object({
      hostId: z.string(),
      context: z.string(),
      machines: z.array(machineSchema),
    }),
  },
  selectMachine: {
    input: z.object({ hostId: identifier }).strict(),
    output: z.null(),
  },
  read: { input: requestSchema, output: resultSchema },
});
export const hostContract = defineRpcContract({
  read: {
    input: z
      .object({
        request: requestSchema,
        binaryPath: z.string().min(1).max(2000),
      })
      .strict(),
    output: resultSchema,
  },
});
