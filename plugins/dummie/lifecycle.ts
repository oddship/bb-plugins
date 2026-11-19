import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Api, ApiError, TransientError, pause, type VM } from "./api.js";
import { type Transport } from "./executor.js";
import { friendlyName } from "./names.js";
export const choicesSchema = z
  .object({
    connection: z.string().min(1).max(80).optional(),
    name: z
      .string()
      .min(3)
      .max(52)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      .optional(),
    recipeId: z.string().max(80).optional(),
    recipeRevision: z.number().int().positive().optional(),
    refreshTransport: z.boolean().optional(),
    retryBootstrap: z.boolean().optional(),
    existingVmId: z.string().uuid().optional(),
    expectedName: z.string().min(1).max(52).optional(),
    host: z.string().uuid().optional(),
    kernel: z.string().uuid().optional(),
    image: z.string().uuid().optional(),
    recover: z.string().min(1).max(256).optional(),
    cpus: z.number().int().min(1).max(8).optional(),
    memoryMiB: z.number().int().min(1024).max(16384).optional(),
    disk: z
      .string()
      .regex(/^[1-9][0-9]*[MG]$/)
      .optional(),
    targets: z.lazy(() => targetsSchema).optional(),
  })
  .nullable();
export type Choices = z.infer<typeof choicesSchema>;
export const targetsSchema = z
  .array(
    z
      .object({
        destination: z.string().min(1).max(253),
        transport: z.enum(["any", "tcp", "udp", "icmp", "tls", "http"]),
        ports: z.string().max(100).optional(),
        kind: z.enum(["domain", "ip", "cidr"]).optional(),
        note: z.string().max(200).optional(),
        ttl_seconds: z.number().int().min(0).max(2678400).optional(),
      })
      .strict(),
  )
  .max(32);
export const allocationSchema = z.object({
  client_id: z.string(),
  kernel_id: z.string(),
  osimage_id: z.string(),
  cpus: z.number().int().positive(),
  memory_mib: z.number().int().positive(),
  disk_size: z.string(),
  targets: targetsSchema,
});
export const resourceSchema = z.object({
  version: z.literal(1),
  key: z.string(),
  owner: z.string(),
  endpoint: z.string(),
  account: z.string(),
  name: z.string(),
  client: z.string(),
  vmId: z.string().optional(),
  phase: z.enum(["prepared", "posting", "allocated", "removed"]),
  allocation: allocationSchema.optional(),
  enrolled: z.boolean().optional(),
  adopted: z.boolean().optional(),
  recoveredFrom: z.string().optional(),
  transferredTo: z.string().optional(),
  transport: z.object({
    executionHostId: z.string().optional(),
    host: z.string(),
    port: z.number().int(),
    fingerprint: z.string(),
    identityFile: z.string(),
  }),
});
export type Resource = z.infer<typeof resourceSchema>;
export interface Store {
  get(key: string): Promise<Resource | null>;
  set(key: string, r: Resource): Promise<void>;
}
export type Allocation = z.infer<typeof allocationSchema>;
export class Lifecycle {
  constructor(
    readonly api: Api,
    readonly store: Store,
    readonly owner: string,
    readonly account: string,
    readonly timeoutMs = 300000,
  ) {}
  async verify(r: Resource) {
    if (
      r.endpoint !== this.api.origin ||
      r.account !== this.account ||
      r.owner !== this.owner
    )
      throw Error(
        "Control endpoint, account or plugin ownership changed. Restore the original settings before lifecycle actions.",
      );
  }
  async intent(
    key: string,
    client: string,
    transport: Transport,
    allocation?: Allocation,
    name?: string,
  ) {
    let r = await this.store.get(key);
    if (r) {
      await this.verify(r);
      return r;
    }
    r = {
      version: 1,
      key,
      owner: this.owner,
      endpoint: this.api.origin,
      account: this.account,
      name:
        name ?? friendlyName(this.owner + this.api.origin + this.account, key),
      client,
      phase: "prepared",
      transport,
      ...(allocation ? { allocation: allocationSchema.parse(allocation) } : {}),
    };
    await this.store.set(key, r);
    return r;
  }
  async adopt(
    key: string,
    vmId: string,
    name: string,
    transport: Transport,
    s: AbortSignal,
  ) {
    const saved = await this.store.get(key);
    if (saved) {
      await this.verify(saved);
      if (
        !saved.adopted ||
        saved.vmId !== vmId ||
        saved.name !== name ||
        saved.phase === "removed"
      )
        throw Error(
          "Enrollment request identity changed. Use the original request.",
        );
      await this.find(saved, s);
      return saved;
    }
    const v = await this.api.get(vmId, s);
    if (
      !v ||
      v.id !== vmId ||
      v.name !== name ||
      v.created_by !== this.account ||
      v.expires_at ||
      !["running", "stopped"].includes(v.status)
    )
      throw Error(
        "Select an owned, persistent VM in running or stopped state with its exact name.",
      );
    const r: Resource = {
      version: 1,
      key,
      owner: this.owner,
      endpoint: this.api.origin,
      account: this.account,
      name: v.name,
      client: v.client_id,
      vmId: v.id,
      phase: "allocated",
      adopted: true,
      transport,
    };
    await this.store.set(key, r);
    return r;
  }
  assertVM(r: Resource, v: VM) {
    if (
      (r.vmId && v.id !== r.vmId) ||
      v.name !== r.name ||
      v.created_by !== r.account ||
      v.client_id !== r.client ||
      v.expires_at
    )
      throw Error(
        "VM ownership, host or persistent lifetime mismatch. Refusing lifecycle action.",
      );
  }
  async find(r: Resource, s: AbortSignal) {
    await this.verify(r);
    if (r.vmId) {
      const v = await this.api.get(r.vmId, s);
      if (v) this.assertVM(r, v);
      return v;
    }
    const matches = (await this.api.list(s)).filter((v) => v.name === r.name);
    if (matches.length > 1)
      throw Error(
        "Multiple VMs match allocation intent. Manual reconciliation required.",
      );
    const v = matches[0] ?? null;
    if (v) this.assertVM(r, v);
    return v;
  }
  async allocate(r: Resource, body: Allocation, s: AbortSignal) {
    if (r.phase === "removed")
      throw Error(
        "This allocation was explicitly removed. Use a new machine key.",
      );
    let v = await this.find(r, s);
    if (v && r.phase === "prepared" && !r.vmId)
      throw Error(
        "VM name already exists. No allocation or adoption was performed; choose another name.",
      );
    if (!v && r.vmId)
      throw Error(
        "The allocated VM was lost. Refusing to replace its identity or disk.",
      );
    if (!v && r.phase === "posting")
      throw Error(
        "Allocation outcome is uncertain. No matching VM is visible. Intent is retained; inspect Dummie before resolving it. No duplicate create was sent.",
      );
    if (!v) {
      s.throwIfAborted();
      body = r.allocation ?? allocationSchema.parse(body);
      if (body.client_id !== r.client)
        throw Error(
          "Allocation host changed since intent was recorded. Restore the original selection.",
        );
      r = { ...r, phase: "posting", allocation: body };
      await this.store.set(r.key, r);
      try {
        v = zVM(
          await this.api.request("/vms", s, "POST", {
            ...body,
            name: r.name,
            ttl_seconds: 0,
          }),
        );
        this.assertVM(r, v);
      } catch (e) {
        s.throwIfAborted();
        v = await this.find(r, s);
        if (!v) {
          // These errors are returned before insertion by the inspected API.
          // A complete rejection is not an uncertain allocation.
          if (
            e instanceof ApiError &&
            [400, 401, 403, 404, 422].includes(e.status)
          ) {
            r = { ...r, phase: "prepared" };
            await this.store.set(r.key, r);
          }
          throw e;
        }
      }
    }
    r = { ...r, vmId: v.id, phase: "allocated" };
    await this.store.set(r.key, r);
    return r;
  }
  async wait(r: Resource, s: AbortSignal, wanted: string | null) {
    const end = Date.now() + this.timeoutMs;
    while (true) {
      s.throwIfAborted();
      let v: VM | null;
      try {
        v = await this.find(r, s);
      } catch (e) {
        if (!(
          e instanceof TransientError ||
          (e instanceof ApiError && e.status >= 500)
        ))
          throw e;
        if (Date.now() > end) throw e;
        await pause(s);
        continue;
      }
      if (wanted === null && !v) return null;
      if (!v)
        throw Error(
          "VM is missing. Files cannot be recovered by allocating a replacement.",
        );
      if (v.status === wanted) return v;
      if (wanted !== null && ["failed", "gone"].includes(v.status))
        throw Error(
          `VM is ${v.status}. Inspect it in Dummie; retained resource: ${r.vmId}.`,
        );
      if (Date.now() > end)
        throw Error(
          `Timed out waiting for VM ${wanted ?? "removal"}. The resource is retained.`,
        );
      await pause(s);
    }
  }
  async start(r: Resource, s: AbortSignal) {
    let v = await this.find(r, s);
    if (!v) throw Error("VM is missing; automatic replacement is disabled.");
    if (v.status === "pending") v = await this.wait(r, s, "running");
    if (v?.status === "stopped")
      await this.api.request("/vms/" + r.vmId + "/start", s, "POST");
    else if (v?.status !== "running")
      throw Error(`Cannot start VM in ${v?.status} state.`);
    await this.wait(r, s, "running");
  }
  async stop(r: Resource, s: AbortSignal) {
    const v = await this.find(r, s);
    if (!v) throw Error("VM is missing.");
    if (v.status !== "stopped") {
      if (v.status !== "running")
        throw Error(`Cannot stop VM in ${v.status} state.`);
      await this.api.request("/vms/" + r.vmId + "/stop", s, "POST");
    }
    await this.wait(r, s, "stopped");
  }
  async remove(r: Resource, s: AbortSignal) {
    if (r.phase === "removed") return;
    // Adoption grants enrollment, never ownership of the VM's disk.
    if (r.adopted) {
      await this.verify(r);
      await this.store.set(r.key, { ...r, phase: "removed" });
      return;
    }
    let v = await this.find(r, s);
    if (v) {
      if (v.status === "pending")
        throw Error(
          "Allocation is still pending. Cleanup will retry after it settles.",
        );
      if (v.vm_id && v.status !== "gone") {
        await this.api.request("/vms/" + v.id + "/destroy", s, "POST");
        await this.wait(r, s, "gone");
      }
      await this.api.request("/vms/" + v.id, s, "DELETE");
      await this.wait(r, s, null);
    } else if (r.phase === "posting")
      throw Error(
        "Uncertain allocation is not visible yet. Cleanup remains pending to avoid orphaning a delayed allocation.",
      );
    r = { ...r, phase: "removed" };
    await this.store.set(r.key, r);
  }
}
function zVM(v: unknown): VM {
  return vmSchema.parse(v);
}
import { vmSchema } from "./api.js";
export function newOwner() {
  return randomUUID();
}
