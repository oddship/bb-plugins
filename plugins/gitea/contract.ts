import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
export const slug = z
  .string()
  .regex(/^[\w.-]+\/[\w.-]+$/)
  .refine(
    (s) => s.split("/").every((p) => p !== "." && p !== ".."),
    "Expected owner/repo",
  );
export const scope = z.object({
  login: z.string().min(1).max(200),
  hostId: z.string().optional(),
});
export const listing = scope.extend({
  repo: slug,
  kind: z.enum(["issues", "pulls"]),
  state: z.enum(["open", "closed", "all"]).default("open"),
  page: z.number().int().min(1).max(10000).default(1),
});
export const detail = scope.extend({
  repo: slug,
  kind: z.enum(["issues", "pulls"]),
  number: z.number().int().positive(),
});
export const repoSchema = z.object({
  name: z.string(),
  url: z.string(),
  description: z.string(),
});
export const itemSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string(),
  url: z.string(),
  state: z.string(),
  author: z.string(),
  updatedAt: z.string(),
  labels: z.array(z.string()),
  head: z.string(),
  base: z.string(),
  merged: z.boolean(),
});
export type Item = z.infer<typeof itemSchema>;
export const commentSchema = z.object({
  author: z.string(),
  body: z.string(),
  url: z.string(),
});
export const hostContract = defineRpcContract({
  logins: {
    input: z.object({}),
    output: z.array(
      z.object({ name: z.string(), url: z.string(), user: z.string() }),
    ),
  },
  repos: {
    input: scope.extend({
      page: z.number().int().min(1).max(10000).default(1),
    }),
    output: z.array(repoSchema),
  },
  items: { input: listing, output: z.array(itemSchema) },
  detail: {
    input: detail,
    output: z.object({ item: itemSchema, comments: z.array(commentSchema) }),
  },
});
export const rpcContract = defineRpcContract({
  connection: {
    input: z.null(),
    output: z.object({
      hostId: z.string(),
      login: z.string(),
      logins: hostContract.logins.output,
    }),
  },
  repos: hostContract.repos,
  items: hostContract.items,
  detail: hostContract.detail,
});
