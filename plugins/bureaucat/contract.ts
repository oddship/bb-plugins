import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
export const projectKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,49}$/);
export const taskId = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,49}-[1-9][0-9]*$/);
export const serviceUrl = z
  .string()
  .url()
  .refine((value) => {
    const u = new URL(value);
    return (
      ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash
    );
  }, "Use an HTTP(S) service URL without credentials, query or fragment")
  .transform((v) => v.replace(/\/+$/, "").replace(/\/api\/v1$/, ""));
export const sortKey = z.enum([
  "default",
  "title",
  "priority",
  "state",
  "number",
  "comments",
  "created",
  "updated",
]);
const filters = {
  q: z.string().max(200).optional(),
  state: z
    .enum(["", "backlog", "unstarted", "started", "completed", "cancelled"])
    .optional(),
  priority: z.number().int().min(0).max(4).optional(),
  label: z.string().max(200).optional(),
  sort: sortKey.optional(),
  direction: z.enum(["asc", "desc"]).optional(),
  perPage: z.number().int().min(1).max(100).optional(),
};
const projectFilters = {
  stateId: z.uuid().optional(),
  assignedTo: z.string().trim().min(1).max(200).optional(),
  createdBy: z.string().trim().min(1).max(200).optional(),
  fromDate: z.iso.date().optional(),
  toDate: z.iso.date().optional(),
};
const text = z.string().max(24000);
export const taskSchema = z.object({
  id: z.string(),
  task_id: taskId,
  project_key: projectKey,
  task_number: z.number().int().positive(),
  title: z.string().max(1000),
  description: text.nullish(),
  state_id: z.string().optional(),
  state_name: z.string(),
  state_type: z.string(),
  priority: z.number(),
  assignees: z
    .array(
      z.object({
        username: z.string(),
        user_id: z.string().optional(),
        id: z.string().optional(),
      }),
    )
    .nullish(),
  labels: z
    .array(z.object({ name: z.string(), id: z.string().optional() }))
    .nullish(),
  created_by: z.string().optional(),
  creator_username: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  comment_count: z.number().optional(),
});
export type Task = z.infer<typeof taskSchema>;
export const projectsSchema = z.object({
  projects: z
    .array(
      z.object({
        id: z.string(),
        project_key: projectKey,
        name: z.string(),
        description: text.nullish(),
      }),
    )
    .nullable()
    .transform((v) => v ?? []),
  page: z.number(),
  total_pages: z.number(),
  total: z.number(),
});
export const tasksSchema = z.object({
  tasks: z
    .array(taskSchema)
    .nullable()
    .transform((v) => v ?? []),
  page: z.number(),
  total_pages: z.number(),
  total: z.number(),
});
export const request = z.discriminatedUnion("action", [
  z.object({ action: z.literal("whoami") }),
  z.object({
    action: z.literal("projects"),
    page: z.number().int().min(1).max(10000).default(1),
    q: z.string().max(200).default(""),
  }),
  z.object({
    action: z.literal("mytasks"),
    ...filters,
    page: z.number().int().min(1).max(10000).default(1),
  }),
  z.object({
    action: z.literal("tasks"),
    ...filters,
    ...projectFilters,
    project: projectKey,
    page: z.number().int().min(1).max(10000).default(1),
    q: z.string().max(200).default(""),
    state: z
      .enum(["", "backlog", "unstarted", "started", "completed", "cancelled"])
      .default(""),
  }),
  z.object({ action: z.literal("task"), id: taskId }),
  z.object({
    action: z.literal("create"),
    project: projectKey,
    title: z.string().trim().min(1).max(1000),
    description: text.optional(),
    stateId: z.uuid().optional(),
    assignees: z.array(z.uuid()).max(50).optional(),
    labels: z.array(z.uuid()).max(50).optional(),
    priority: z.number().int().min(0).max(4).optional(),
  }),
  z
    .object({
      action: z.literal("update"),
      id: taskId,
      title: z.string().trim().min(1).max(1000).optional(),
      description: text.optional(),
      stateId: z.uuid().optional(),
      priority: z.number().int().min(0).max(4).optional(),
    })
    .refine(
      (v) =>
        v.title !== undefined ||
        v.description !== undefined ||
        v.stateId !== undefined ||
        v.priority !== undefined,
      "Provide a field to update",
    ),
  z.object({
    action: z.literal("comment"),
    id: taskId,
    content: z.string().trim().min(1).max(24000),
  }),
]);
export type Request = z.infer<typeof request>;
export const result = z.union([
  projectsSchema,
  tasksSchema,
  taskSchema,
  z.object({
    id: z.string(),
    username: z.string(),
    email: z.string().optional(),
  }),
  z.object({ id: z.string(), content: text }),
]);
export const hostContract = defineRpcContract({
  execute: {
    input: z.object({
      binary: z.string().min(1).max(4096),
      baseUrl: serviceUrl,
      request,
    }),
    output: result,
  },
});
export const rpcContract = defineRpcContract({
  execute: {
    input: z.object({ request, hostId: z.string().optional() }),
    output: result,
  },
  connection: {
    input: z.null(),
    output: z.object({
      hostId: z.string(),
      url: z.string(),
      username: z.string(),
    }),
  },
});
