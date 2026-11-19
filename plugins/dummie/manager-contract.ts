import { z } from "zod";
import { isIP } from "node:net";
export const id = z.string().uuid();
export const vmName = z
  .string()
  .min(3)
  .max(52)
  .regex(
    /^[a-z0-9]+(-[a-z0-9]+)*$/,
    "Use lowercase letters, digits and single hyphens.",
  );
export function diskMiB(value: string) {
  return Number(value.slice(0, -1)) * (value.endsWith("G") ? 1024 : 1);
}
export const disk = z
  .string()
  .regex(/^[1-9][0-9]*[MG]$/, "Use a size such as 4G or 512M.")
  .refine(
    (v) => diskMiB(v) >= 64 && diskMiB(v) <= 65536,
    "Disk must be between 64 MiB and 64 GiB.",
  );
export const ruleSchema = z
  .object({
    kind: z.enum(["domain", "ip"]),
    destination: z.string().trim().min(1).max(253),
    transport: z.enum(["tcp", "udp", "icmp", "any"]),
    ports: z.string().trim().max(100),
    note: z.string().trim().max(200),
    ttlSeconds: z.number().int().min(0).max(2678400),
  })
  .strict()
  .superRefine((r, ctx) => {
    const [address, prefix, ...rest] = r.destination.split("/");
    const ipv = isIP(address!);
    const validIP =
      !!ipv &&
      rest.length === 0 &&
      (prefix === undefined ||
        (/^\d+$/.test(prefix) && Number(prefix) <= (ipv === 4 ? 32 : 128)));
    if (r.kind === "ip" && !validIP)
      ctx.addIssue({
        code: "custom",
        path: ["destination"],
        message: "Enter an IP address or CIDR.",
      });
    if (
      r.kind === "domain" &&
      !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(
        r.destination,
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["destination"],
        message: "Enter a domain without a scheme, path or wildcard.",
      });
    if (
      r.kind === "domain" &&
      !["", "80", "443", "80,443", "443,80", "none"].includes(r.ports)
    )
      ctx.addIssue({
        code: "custom",
        path: ["ports"],
        message: "Domain ports must be 80, 443, 80,443 or none.",
      });
    if (
      r.kind === "ip" &&
      r.transport !== "icmp" &&
      r.ports !== "" &&
      (!/^\d+(?::\d+)?(?:,\d+(?::\d+)?)*$/.test(r.ports) ||
        r.ports.split(/[,:]/).some((p) => Number(p) < 1 || Number(p) > 65535) ||
        r.ports
          .split(",")
          .some(
            (p) =>
              p.includes(":") &&
              Number(p.split(":")[0]) > Number(p.split(":")[1]),
          ))
    )
      ctx.addIssue({
        code: "custom",
        path: ["ports"],
        message:
          "Use ports 1-65535, lists or increasing ranges such as 8000:8100.",
      });
    if (
      r.kind === "ip" &&
      ["0.0.0.0/0", "::/0"].includes(r.destination) &&
      r.transport === "any" &&
      !r.ports &&
      r.ttlSeconds === 0
    )
      ctx.addIssue({
        code: "custom",
        path: ["ttlSeconds"],
        message: "An allow-all rule requires an explicit expiry.",
      });
  });
export type Rule = z.infer<typeof ruleSchema>;
export const targetSchema = z.object({
  id: z.string(),
  rule: ruleSchema,
  expiresAt: z.string(),
});
export const profileSchema = z
  .object({
    host: id,
    kernel: id,
    image: id,
    cpus: z.number().int().min(1).max(8),
    memoryMiB: z.number().int().min(64).max(16384),
    disk,
    targets: z.array(ruleSchema).max(32),
  })
  .strict();
export type Profile = z.infer<typeof profileSchema>;
export const recipeIntegrationSchema = z
  .object({
    origin: z.string().url(),
    integrationId: id,
    name: z.string().min(1).max(100),
    kind: z.literal("gitlab"),
    acceptTokenScope: z.literal(true),
  })
  .strict();
export const recipeSchema = z
  .object({
    id: z.string().min(1).max(80),
    revision: z.number().int().positive(),
    name: z.string().trim().min(1).max(80),
    description: z.string().max(1000),
    mode: z.enum(["bb", "plain"]),
    profile: profileSchema.nullable(),
    integrations: z.array(recipeIntegrationSchema).max(1).optional(),
    bootstrapScript: z
      .string()
      .max(32768)
      .refine((v) => !v.includes("\0"), "Scripts cannot contain NUL bytes."),
    timeoutSeconds: z.number().int().min(30).max(1800),
    builtin: z.boolean(),
  })
  .strict();
export type Recipe = z.infer<typeof recipeSchema>;
export const setupRunSchema = z.object({
  recipeName: z.string(),
  revision: z.number(),
  state: z.enum(["pending", "running", "complete", "failed", "uncertain"]),
  message: z.string(),
  log: z.string(),
});
export const choiceSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  sizeBytes: z.number(),
  source: z.string(),
});
export const quotaSchema = z.object({
  vcpu_limit: z.number(),
  vcpu_used: z.number(),
  memory_limit_mib: z.number(),
  memory_used_mib: z.number(),
  disk_limit_mib: z.number(),
  disk_used_mib: z.number(),
});
export const publicOperation = z.object({
  action: z.string(),
  state: z.enum(["pending", "uncertain", "complete", "failed"]),
  message: z.string(),
  startedAt: z.number(),
});
export const capabilitiesSchema = z.object({
  start: z.boolean(),
  stop: z.boolean(),
  remove: z.boolean(),
  reconcile: z.boolean(),
  retryCleanup: z.boolean(),
  edit: z.boolean(),
  resize: z.boolean(),
  egress: z.boolean(),
  reason: z.string(),
});
export const publicVmSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  cpus: z.number(),
  memoryMiB: z.number(),
  diskMiB: z.number(),
  ip: z.string(),
  boot: z.string(),
  defaultUser: z.string(),
  defaultPort: z.number(),
  publicPorts: z.array(z.number()),
  hostName: z.string(),
  kernelName: z.string(),
  kernelId: z.string(),
  createdAt: z.string(),
  reportedAt: z.string(),
  expiresAt: z.string(),
  error: z.string(),
  management: z.enum(["bb", "plain", "protected"]),
  retainedDisk: z.boolean().default(false),
  bb: z
    .object({
      hostId: z.string(),
      name: z.string(),
      status: z.string(),
      phase: z.string(),
    })
    .nullable(),
  capabilities: capabilitiesSchema,
  operation: publicOperation.nullable(),
});
export type ManagedVm = z.infer<typeof publicVmSchema>;
export const receiptSchema = z.object({
  key: z.string(),
  mode: z.enum(["bb", "plain"]),
  name: z.string(),
  state: z.enum(["prepared", "posting", "confirmed", "rejected"]),
  message: z.string(),
  hostId: z.string().optional(),
  vmId: z.string().optional(),
  createdAt: z.number(),
});
export const createSchema = z
  .object({
    key: z.string().uuid(),
    mode: z.enum(["bb", "plain"]),
    name: vmName.optional(),
    recipeId: z.string().max(80).optional(),
    recipeRevision: z.number().int().positive().optional(),
    profile: profileSchema,
    acknowledgeHostNotice: z.boolean(),
  })
  .strict();
export type CreateInput = z.infer<typeof createSchema>;
export const identity = z.object({ id, expectedName: vmName }).strict();
export const actionSchema = identity
  .extend({
    action: z.enum(["start", "stop", "remove", "reconcile", "retryCleanup"]),
    confirmation: z.string().max(52).default(""),
  })
  .strict();
export const editSchema = z.discriminatedUnion("kind", [
  identity
    .extend({
      kind: z.literal("ports"),
      defaultPort: z.number().int().min(1).max(65535),
      publicPorts: z.array(z.number().int().min(1).max(65535)).max(32),
    })
    .strict(),
  identity
    .extend({
      kind: z.literal("user"),
      defaultUser: z
        .string()
        .max(32)
        .regex(/^(?:[a-zA-Z0-9_.][a-zA-Z0-9_.-]*)?$/),
    })
    .strict(),
  identity
    .extend({
      kind: z.literal("size"),
      cpus: z.number().int().min(1).max(8),
      memoryMiB: z.number().int().min(64).max(16384),
      disk,
    })
    .strict(),
]);
export const integrationSchema = z.object({
  id,
  name: z.string().max(100),
  kind: z.string().default(""),
  instance: z.string().max(253).default(""),
  connected: z.boolean().default(false),
  suspended: z.boolean().default(false),
  readonly: z.boolean().default(true),
  all_repos: z.boolean().default(false),
  repos: z.array(z.string().max(300)).max(1000).default([]),
});
export const integrationEdit = identity
  .extend({
    integrationId: id,
    acceptTokenScope: z.boolean().default(false),
    repos: z
      .array(z.string().regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/))
      .max(100),
  })
  .strict();
export const managerMethods = {
  integrations_catalog: {
    input: z.null(),
    output: z.object({
      origin: z.string().url(),
      available: z.array(integrationSchema),
    }),
  },
  integrations_status: {
    input: z.object({ id }).strict(),
    output: z.object({
      origin: z.string().url(),
      available: z.array(integrationSchema),
      attached: z.array(integrationSchema),
    }),
  },
  integrations_save: {
    input: integrationEdit,
    output: z.object({ message: z.string() }),
  },
  integrations_detach: {
    input: identity.extend({ integrationId: id }).strict(),
    output: z.object({ message: z.string() }),
  },
  recipes_list: { input: z.null(), output: z.array(recipeSchema).max(52) },
  recipes_save: { input: recipeSchema, output: recipeSchema },
  recipes_delete: {
    input: z
      .object({ id: z.string().max(80), revision: z.number().int().positive() })
      .strict(),
    output: z.object({ deleted: z.literal(true) }),
  },
  setup_status: { input: identity, output: setupRunSchema.nullable() },
  setup_retry: {
    input: identity.extend({ confirmation: z.string().max(52) }).strict(),
    output: z.object({ message: z.string() }),
  },
  manager_enroll: {
    input: identity,
    output: z.object({ hostId: z.string(), message: z.string() }),
  },
  manager_inventory: {
    input: z
      .object({
        search: z.string().max(100).default(""),
        status: z.string().max(30).default("all"),
        offset: z.number().int().min(0).max(1000).default(0),
        limit: z.number().int().min(1).max(50).default(20),
      })
      .strict(),
    output: z.object({
      vms: z.array(publicVmSchema),
      total: z.number(),
      scanned: z.number(),
      limited: z.boolean(),
      requests: z.array(receiptSchema),
    }),
  },
  manager_detail: {
    input: z.object({ id }).strict(),
    output: z.object({
      vm: publicVmSchema.nullable(),
      targets: z.array(targetSchema),
      operation: publicOperation.nullable(),
      targetCount: z.number(),
    }),
  },
  manager_setup: {
    input: z.null(),
    output: z.object({
      hosts: z.array(choiceSchema),
      kernels: z.array(choiceSchema),
      images: z.array(choiceSchema),
      quota: quotaSchema,
      defaults: profileSchema.nullable(),
      hostNetworkNotice: z.string(),
      capabilityNotes: z.array(z.string()),
    }),
  },
  manager_defaults: {
    input: profileSchema,
    output: z.object({ saved: z.literal(true) }),
  },
  manager_create: { input: createSchema, output: receiptSchema },
  manager_request: {
    input: z.object({ key: z.string().uuid() }).strict(),
    output: receiptSchema,
  },
  manager_action: {
    input: actionSchema,
    output: z.object({ message: z.string() }),
  },
  manager_edit: {
    input: editSchema,
    output: z.object({ message: z.string() }),
  },
  manager_target_save: {
    input: identity
      .extend({ targetId: id.optional(), rule: ruleSchema })
      .strict(),
    output: z.object({ message: z.string() }),
  },
  manager_target_remove: {
    input: identity
      .extend({ targetId: id, confirmation: z.string().max(253) })
      .strict(),
    output: z.object({ message: z.string() }),
  },
} as const;

export type Setup = z.infer<typeof managerMethods.manager_setup.output>;
export type Inventory = z.infer<typeof managerMethods.manager_inventory.output>;
export type Detail = z.infer<typeof managerMethods.manager_detail.output>;
export type Receipt = z.infer<typeof receiptSchema>;
