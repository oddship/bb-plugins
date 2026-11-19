import { z } from "zod";
import { targetsSchema } from "./lifecycle.js";

export const remoteSchema = z.object({
  id: z.string().min(1).max(80),
  label: z.string().trim().min(1).max(60),
  controlUrl: z.string().url().max(2048),
  token: z.string().min(1).max(8192),
  executionHostId: z.string().max(100).default(""),
  sshHost: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[a-zA-Z0-9.:-]+$/),
  sshPort: z.number().int().min(1).max(65535).default(22),
  sshFingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}=?$/),
  identityFile: z.string().max(4096).default(""),
  host: z.string().default(""),
  kernel: z.string().default(""),
  image: z.string().default(""),
  cpus: z.number().int().min(1).max(8).default(1),
  memory: z.number().int().min(1024).max(16384).default(1024),
  disk: z
    .string()
    .regex(/^[1-9][0-9]*[MG]$/)
    .default("4G"),
  targets: z
    .string()
    .refine((v) => {
      try {
        targetsSchema.parse(JSON.parse(v));
        return true;
      } catch {
        return false;
      }
    })
    .default("[]"),
});
export const remoteList = z.array(remoteSchema).max(20);
export const remoteInput = remoteSchema
  .pick({
    label: true,
    controlUrl: true,
    sshHost: true,
    sshPort: true,
    sshFingerprint: true,
    identityFile: true,
  })
  .extend({
    executionHostId: z.string().max(100).optional(),
    id: z.string().min(1).max(80).optional(),
    token: z.string().max(8192).optional(),
  })
  .strict();
