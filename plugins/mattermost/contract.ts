import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
export const mattermostId = z
  .string()
  .regex(/^[a-z0-9]{26}$/, "Expected a Mattermost ID");
const threadId = z.string().regex(/^thr_[a-zA-Z0-9]+$/);
const period = z.enum(["6h", "1d", "7d"]).default("1d");
const refresh = z.boolean().optional();
export const requestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("overview"), since: period, refresh }).strict(),
  z.object({ kind: z.literal("mentions"), since: period, refresh }).strict(),
  z.object({ kind: z.literal("channels"), refresh }).strict(),
  z.object({ kind: z.literal("unread"), refresh }).strict(),
  z
    .object({ kind: z.literal("messages"), target: mattermostId, refresh })
    .strict(),
  z
    .object({
      kind: z.literal("thread"),
      target: mattermostId,
      limit: z
        .union([
          z.literal(100),
          z.literal(200),
          z.literal(500),
          z.literal(1000),
        ])
        .optional(),
      refresh,
    })
    .strict(),
  z
    .object({
      kind: z.literal("search"),
      query: z
        .string()
        .trim()
        .min(2)
        .max(300)
        .refine((s) => !s.startsWith("-"), "Search must not start with a dash"),
      refresh,
    })
    .strict(),
]);
export type Request = z.infer<typeof requestSchema>;
export const fileSchema = z.object({
  id: mattermostId,
  name: z.string(),
  size: z.number().nonnegative().optional(),
  mime_type: z.string().optional(),
  extension: z.string().optional(),
});
export type Attachment = z.infer<typeof fileSchema>;
export const starSchema = z.object({
  conversationId: mattermostId,
  title: z.string().max(180),
  createdAt: z.string(),
  pinned: z.boolean(),
});
export type StarredConversation = z.infer<typeof starSchema>;
export const postSchema = z.object({
  id: z.string().optional(),
  thread_id: z.string().optional(),
  author: z.string(),
  message: z.string(),
  created_at: z.string(),
  channel: z.string().optional(),
  channel_id: z.string().optional(),
  is_reply: z.boolean().optional(),
  root: z
    .object({ author: z.string(), message: z.string(), created_at: z.string() })
    .optional(),
  reply_count: z.number().optional(),
  file_count: z.number().optional(),
  files: z.array(fileSchema).optional(),
});
export type Post = z.infer<typeof postSchema>;
export const channelSchema = z.object({
  id: z.string().optional(),
  channel_id: z.string().optional(),
  unread: z.number().optional(),
  name: z.string().optional(),
  channel: z.string().optional(),
  ref: z.string().optional(),
  type: z.string().optional(),
  team: z.string().optional(),
  last_post_at: z.string().optional(),
});
export type Channel = z.infer<typeof channelSchema>;
export const overviewSchema = z.object({
  since: z.string(),
  mentions: z.array(postSchema),
  unread: z.array(channelSchema),
  active_channels: z.array(channelSchema).default([]),
});
export type Overview = z.infer<typeof overviewSchema>;
export const snapshotSchema = z.object({
  fetchedAt: z.string(),
  data: z.union([overviewSchema, z.array(postSchema), z.array(channelSchema)]),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export const resultSchema = snapshotSchema.extend({
  cache: z.enum(["fresh", "stale", "network"]).default("network"),
  refreshing: z.boolean().default(false),
  refreshError: z.string().optional(),
});
export type ReadResult = z.infer<typeof resultSchema>;
export const linkSchema = z.object({
  conversationId: mattermostId,
  title: z.string().max(180),
  createdAt: z.string(),
});
export type ConversationLink = z.infer<typeof linkSchema>;
export const contextSchema = z.object({
  threadId: threadId.nullable(),
  title: z.string(),
  project: z.string().default(""),
  branch: z.string().default(""),
  suggestedQuery: z.string(),
  links: z.array(linkSchema),
});
export type ThreadContext = z.infer<typeof contextSchema>;
export const rpcContract = defineRpcContract({
  read: { input: requestSchema, output: resultSchema },
  stars: { input: z.null(), output: z.array(starSchema) },
  star: {
    input: z
      .object({
        conversationId: mattermostId,
        title: z.string().trim().min(1).max(180),
        action: z.enum(["star", "unstar", "pin", "unpin"]),
      })
      .strict(),
    output: z.array(starSchema),
  },
  context: {
    input: z.object({ threadId: threadId.nullable() }),
    output: contextSchema,
  },
  link: {
    input: z
      .object({
        threadId,
        conversationId: mattermostId,
        title: z.string().trim().min(1).max(180),
        remove: z.boolean().default(false),
      })
      .strict(),
    output: z.array(linkSchema),
  },
});
export const hostContract = defineRpcContract({
  attachment: {
    input: z.object({ fileId: mattermostId }).strict(),
    output: fileSchema,
    experimental_retryable: true,
  },
  attachmentChunk: {
    input: z
      .object({
        fileId: mattermostId,
        offset: z
          .number()
          .int()
          .min(0)
          .max(64 * 1024 * 1024),
        length: z
          .number()
          .int()
          .min(1)
          .max(1024 * 1024),
      })
      .strict(),
    output: z.object({ base64: z.string().max(1400000) }),
    experimental_retryable: true,
  },
  read: {
    input: requestSchema,
    output: snapshotSchema,
    experimental_retryable: true,
  },
});
