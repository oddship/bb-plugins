import { checkRecipeIntegrations } from "./recipe-integrations.js";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { Api, ApiError, vmSchema, type VM } from "./api.js";
import { resourceSchema, type Resource, type Lifecycle } from "./lifecycle.js";
import { friendlyName } from "./names.js";
import {
  actionSchema,
  integrationSchema,
  integrationEdit,
  createSchema,
  editSchema,
  identity,
  profileSchema,
  quotaSchema,
  ruleSchema,
  diskMiB,
  receiptSchema,
  recipeSchema,
  vmName,
  type Recipe,
  type Rule,
  type Profile,
  type ManagedVm,
} from "./manager-contract.js";
export type Config = {
  connection?: string;
  host: string;
  kernel: string;
  image: string;
  cpus: number;
  memory: number;
  disk: string;
  targets: string;
  hostNetworkNotice: string;
};
type Host = Awaited<ReturnType<BbPluginApi["sdk"]["hosts"]["list"]>>[number];
export interface ManagerDeps {
  bb: BbPluginApi;
  owner: string;
  signal: AbortSignal;
  connect(
    signal: AbortSignal,
  ): Promise<{ api: Api; life: Lifecycle; cfg: Config }>;
  resources(): Promise<Resource[]>;
  getRecipe?(id: string, revision?: number): Promise<Recipe>;
  pinRecipe?(key: string, recipe: Recipe): Promise<void>;
  queueRecipe?(
    vm: VM,
    recipe: Recipe,
    cfg: Config,
    origin: string,
    account: string,
  ): Promise<void>;
  setupBusy?(origin: string, account: string, id: string): Promise<boolean>;
  saveDefaults(profile: Profile, connection?: string): Promise<void>;
  locked<T>(key: string, fn: () => Promise<T>): Promise<T>;
}
const receiptRecord = receiptSchema.extend({
  recipe: recipeSchema.optional(),
  account: z.string(),
  endpoint: z.string(),
  fingerprint: z.string(),
  body: z.record(z.string(), z.json()),
});
type Receipt = z.infer<typeof receiptRecord>;
const operationSchema = z.object({
  vmId: z.string(),
  name: z.string(),
  account: z.string(),
  endpoint: z.string(),
  action: z.string(),
  state: z.enum(["pending", "uncertain", "complete", "failed"]),
  message: z.string(),
  startedAt: z.number(),
  stage: z.string(),
  desired: z.record(z.string(), z.json()),
});
type Operation = z.infer<typeof operationSchema>;
type Context = { api: Api; account: string; cfg: Config; signal: AbortSignal };
type Ownership = {
  kind: "bb" | "plain" | "protected";
  host: Host | null;
  resource: Resource | null;
  reason: string;
};
const activeOperation = (o: Operation | null) =>
  o?.state === "pending" || o?.state === "uncertain";
const publicOp = (o: Operation | null) =>
  o
    ? {
        action: o.action,
        state: o.state,
        message: o.message,
        startedAt: o.startedAt,
      }
    : null;
const publicReceipt = (r: Receipt) => receiptSchema.parse(r);
export const apiRule = (r: Rule) => ({
  kind: r.kind,
  destination:
    r.kind === "domain" ? r.destination.toLowerCase() : r.destination,
  transport: r.transport,
  ports:
    r.transport === "icmp" && r.kind === "ip"
      ? ""
      : r.kind === "domain" && ["80,443", "443,80"].includes(r.ports)
        ? ""
        : r.ports,
  note: r.note,
  ttl_seconds: r.ttlSeconds,
});
function ruleFromApi(raw: unknown): Rule {
  const r = z
    .object({
      kind: z.string().optional(),
      destination: z.string(),
      transport: z.string().optional(),
      ports: z.string().optional(),
      note: z.string().optional(),
      expires_at: z.string().optional(),
      ttl_seconds: z.number().optional(),
    })
    .parse(raw);
  const kind =
    r.kind === "domain" || (!r.kind && !isIP(r.destination.split("/")[0]!))
      ? "domain"
      : "ip";
  return ruleSchema.parse({
    kind,
    destination: r.destination,
    transport: kind === "domain" ? "tcp" : r.transport || "tcp",
    ports: r.ports || "",
    note: (r.note || "").slice(0, 200),
    ttlSeconds: r.expires_at
      ? Math.max(
          1,
          Math.min(
            2678400,
            Math.ceil((Date.parse(r.expires_at) - Date.now()) / 1000),
          ),
        )
      : r.ttl_seconds || 0,
  });
}
function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export class Manager {
  constructor(readonly deps: ManagerDeps) {}
  async context(): Promise<Context> {
    const signal = AbortSignal.any([
      this.deps.signal,
      AbortSignal.timeout(25000),
    ]);
    const { api, life, cfg } = await this.deps.connect(signal);
    return { api, account: life.account, cfg, signal };
  }
  async catalogs(c: Context) {
    const [hosts, kernels, images] = await Promise.all(
      ["hosts", "kernels", "osimages"].map((kind) =>
        c.api.choices(kind as "hosts" | "kernels" | "osimages", c.signal),
      ),
    );
    return { hosts: hosts!, kernels: kernels!, images: images! };
  }
  async setup() {
    const c = await this.context();
    const [catalogs, quota] = await Promise.all([
      this.catalogs(c),
      this.quota(c),
    ]);
    const choice = (r: (typeof catalogs.hosts)[number]) => ({
      id: r.id,
      name: r.name || r.hostname || "Unnamed entry",
      description: (r.description || "").slice(0, 500),
      sizeBytes: r.size_bytes || 0,
      source:
        r.source === "oci"
          ? "Container image"
          : r.source === "upload"
            ? "Uploaded rootfs"
            : "",
    });
    let defaults: Profile | null = null;
    try {
      defaults = profileSchema.parse({
        host: c.cfg.host,
        kernel: c.cfg.kernel,
        image: c.cfg.image,
        cpus: c.cfg.cpus,
        memoryMiB: c.cfg.memory,
        disk: c.cfg.disk,
        targets: JSON.parse(c.cfg.targets).map(ruleFromApi),
      });
    } catch {}
    return {
      ...(Object.fromEntries(
        Object.entries(catalogs).map(([key, rows]) => [key, rows.map(choice)]),
      ) as {
        hosts: ReturnType<typeof choice>[];
        kernels: ReturnType<typeof choice>[];
        images: ReturnType<typeof choice>[];
      }),
      quota,
      defaults,
      hostNetworkNotice: c.cfg.hostNetworkNotice,
      capabilityNotes: [
        "BB machines use core enrollment and lifecycle. Raw configuration and general egress edits are disabled for managed VMs; Network access can temporarily allow recorded web blocks.",
        "Plain Dummie VMs have no BB daemon enrollment. Resize is available only while stopped, without changing the kernel.",
        "VM rename and existing-VM kernel/image replacement are unavailable here. Host/kernel/image catalog administration and image uploads remain in Dummie.",
        "Catalog entries are read only here. Rule allowlists do not prove DNS, forwarding or policy enforcement.",
      ],
    };
  }
  async quota(c: Context) {
    return quotaSchema.parse(await c.api.request("/vms/quota", c.signal));
  }
  async checkProfile(c: Context, p: Profile, previous?: VM) {
    const catalog = await this.catalogs(c);
    if (!catalog.hosts.some((h) => h.id === p.host))
      throw Error("Choose a currently connected Dummie host.");
    if (!catalog.kernels.some((k) => k.id === p.kernel))
      throw Error("Choose an available kernel.");
    if (!catalog.images.some((i) => i.id === p.image))
      throw Error("Choose an available OS image.");
    const q = await this.quota(c);
    if (
      q.vcpu_used - (previous?.cpus || 0) + p.cpus > q.vcpu_limit ||
      q.memory_used_mib - (previous?.memory_mib || 0) + p.memoryMiB >
        q.memory_limit_mib ||
      q.disk_used_mib - (previous?.disk_mib || 0) + diskMiB(p.disk) >
        q.disk_limit_mib
    )
      throw Error(
        "This size exceeds current account quota. Review Quota & defaults; existing VMs were not changed.",
      );
  }
  async saveDefaults(input: unknown) {
    const p = profileSchema.parse(input);
    if (p.memoryMiB < 1024)
      throw Error("BB defaults require at least 1024 MiB RAM.");
    const c = await this.context();
    const cat = await this.catalogs(c);
    if (
      !cat.hosts.some((h) => h.id === p.host) ||
      !cat.kernels.some((k) => k.id === p.kernel) ||
      !cat.images.some((i) => i.id === p.image)
    )
      throw Error("Select available host, kernel and image entries.");
    await this.deps.saveDefaults(p, c.cfg.connection);
    return { saved: true as const };
  }
  async ownership(c: Context, v: VM): Promise<Ownership> {
    if (v.created_by !== c.account)
      throw Error("VM is not owned by the authenticated account.");
    const records = await this.deps.resources();
    const hosts = await this.deps.bb.sdk.hosts.list();
    if (hosts.length > 1000)
      throw Error("Too many BB hosts for safe ownership reconciliation.");
    let unrecognized = false;
    const candidates: { r: Resource; h: Host | null }[] = records
      .filter(
        (r) =>
          r.phase !== "removed" &&
          (r.vmId === v.id ||
            (r.endpoint === c.api.origin && r.name === v.name)),
      )
      .map((r) => ({ r, h: null }));
    for (let offset = 0; offset < hosts.length; offset += 16) {
      await Promise.all(
        hosts.slice(offset, offset + 16).map(async (h) => {
          const raw = await this.deps.bb.experimental_machines.getResource(
            h.id,
          );
          const parsed = resourceSchema.safeParse(raw);
          if (raw && typeof raw === "object" && !Array.isArray(raw)) {
            const candidate = raw as Record<string, unknown>;
            if (
              (candidate.vmId === v.id ||
                (candidate.endpoint === c.api.origin &&
                  candidate.name === v.name)) &&
              !parsed.success
            )
              unrecognized = true;
          }
          if (
            parsed.success &&
            parsed.data.phase !== "removed" &&
            (parsed.data.vmId === v.id ||
              (parsed.data.endpoint === c.api.origin &&
                parsed.data.name === v.name))
          )
            candidates.push({ r: parsed.data, h });
        }),
      );
    }
    if (unrecognized)
      return {
        kind: "protected",
        host: null,
        resource: null,
        reason:
          "A BB resource matches this VM but its ownership format is not recognized. Raw operations are disabled.",
      };
    if (!candidates.length)
      return { kind: "plain", host: null, resource: null, reason: "" };
    const mismatch = candidates.find(
      ({ r }) =>
        r.owner !== this.deps.owner ||
        r.endpoint !== c.api.origin ||
        r.account !== c.account ||
        r.name !== v.name ||
        r.client !== v.client_id ||
        (r.vmId && r.vmId !== v.id),
    );
    if (mismatch)
      return {
        kind: "protected",
        host: null,
        resource: null,
        reason:
          "Tracked identity or account/control endpoint differs. Raw operations are disabled; restore the original connection and inspect ownership.",
      };
    const transferred = new Map(records.map((r) => [r.key, r.transferredTo]));
    const current = candidates.filter(
      ({ r }) =>
        !r.transferredTo && !transferred.get(r.key) && r.phase !== "removed",
    );
    const mapped = current.filter((x) => x.h);
    if (mapped.length === 1 && mapped[0]!.h!.machineProviderId === "dummie")
      return {
        kind: "bb",
        host: mapped[0]!.h,
        resource: mapped[0]!.r,
        reason: "",
      };
    return {
      kind: "protected",
      host: null,
      resource: current[0]?.r || null,
      reason:
        "This VM belongs to a tracked or transferred BB allocation without one current manageable host. Use BB recovery/cleanup; raw operations are disabled.",
    };
  }
  opKey(c: Context, id: string) {
    return "manager:operation:" + hash([c.api.origin, c.account, id]);
  }
  async operation(c: Context, id: string) {
    const raw = await this.deps.bb.storage.kv.get(this.opKey(c, id));
    return raw ? operationSchema.parse(raw) : null;
  }
  async putOp(c: Context, o: Operation) {
    await this.deps.bb.storage.kv.set(this.opKey(c, o.vmId), o);
  }
  async targets(c: Context, v: VM) {
    const raw = z
      .object({
        items: z
          .array(
            z.object({
              id: z.string(),
              destination: z.string(),
              kind: z.string(),
              transport: z.string(),
              ports: z.string(),
              note: z.string(),
              expires_at: z.string().optional(),
            }),
          )
          .max(1000),
      })
      .parse(await c.api.request("/vms/" + v.id + "/targets", c.signal));
    return raw.items.map((r) => ({
      id: r.id,
      rule: ruleFromApi(r),
      expiresAt: r.expires_at || "",
    }));
  }
  async progress(c: Context, v: VM | null, o: Operation | null) {
    if (!o || !activeOperation(o)) return o;
    if (o.account !== c.account || o.endpoint !== c.api.origin)
      throw Error("Operation belongs to another account/control endpoint.");
    if (v && v.name !== o.name)
      throw Error("VM identity changed during operation.");
    if (!v) {
      o = {
        ...o,
        state: o.action === "remove" ? "complete" : "failed",
        message:
          o.action === "remove"
            ? "VM and disk removed."
            : "VM is no longer present.",
      };
      await this.putOp(c, o);
      return o;
    }
    const ownership = await this.ownership(c, v);
    if (ownership.kind !== "plain") {
      o = {
        ...o,
        state: "uncertain",
        message:
          "VM is now tracked by BB. Raw reconciliation paused; inspect its BB machine.",
      };
      await this.putOp(c, o);
      return o;
    }
    let done = false;
    if (o.action === "remove" && v.status === "gone") {
      o = { ...o, stage: "purging" };
      await this.putOp(c, o);
      try {
        await c.api.request("/vms/" + v.id, c.signal, "DELETE");
        done = true;
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) done = true;
        else {
          o = {
            ...o,
            state: "uncertain",
            message:
              "Disk removal observed; record purge is not confirmed. Refresh to reconcile.",
          };
        }
      }
    } else if (o.action === "start" || o.action === "stop")
      done = v.status === o.desired.status;
    else if (o.action === "size")
      done =
        v.cpus === o.desired.cpus &&
        v.memory_mib === o.desired.memory_mib &&
        v.disk_mib === o.desired.disk_mib;
    else if (o.action === "user")
      done = (v.default_user || "") === o.desired.default_user;
    else if (o.action === "ports")
      done =
        v.default_port === o.desired.default_port &&
        JSON.stringify([...(v.public_ports || [])].sort((a, b) => a - b)) ===
          JSON.stringify(
            [...(o.desired.public_ports as number[])].sort((a, b) => a - b),
          );
    else if (o.action.startsWith("target-")) {
      const rules = await this.targets(c, v);
      const desired = o.desired;
      done =
        o.action === "target-remove"
          ? !rules.some((r) => r.id === desired.targetId)
          : rules.some(
              (r) =>
                r.rule.destination === desired.destination &&
                r.rule.kind === desired.kind &&
                r.rule.ports === desired.ports &&
                r.rule.transport === desired.transport &&
                r.rule.note === desired.note,
            );
    }
    if (done)
      o = {
        ...o,
        state: "complete",
        message:
          o.action === "remove"
            ? "VM and disk removed."
            : "Change confirmed by Dummie.",
      };
    else if (v.status === "failed" && ["start", "stop"].includes(o.action))
      o = {
        ...o,
        state: "failed",
        message:
          "Dummie reports guest failure. Inspect host logs before retrying.",
      };
    else if (Date.now() - o.startedAt > 300000)
      o = {
        ...o,
        state: "uncertain",
        message:
          "Completion is still not confirmed. Further writes are blocked; inspect Dummie host state and refresh. No request was repeated.",
      };
    await this.putOp(c, o);
    return o;
  }
  capabilities(v: VM, own: Ownership, o: Operation | null, online: boolean) {
    const empty = {
      start: false,
      stop: false,
      remove: false,
      reconcile: false,
      retryCleanup: false,
      edit: false,
      resize: false,
      egress: false,
      reason: "",
    };
    if (own.kind === "protected") return { ...empty, reason: own.reason };
    if (own.kind === "bb") {
      const h = own.host!;
      const phase = h.lifecycle.phase;
      const stable = ["active", "suspended"].includes(phase);
      const cleanup =
        phase === "removing" && h.lifecycle.teardown?.status === "failed";
      return {
        ...empty,
        start: phase === "suspended",
        stop: phase === "active",
        remove: stable || cleanup,
        reconcile: phase === "suspended",
        retryCleanup: cleanup,
        reason:
          stable || cleanup
            ? "BB owns this machine. Use core lifecycle controls. Ports, session user, resize and general egress edits are read only. Use Network access to allow a recorded web destination temporarily."
            : `BB is ${phase}. Wait for its lifecycle operation to settle.`,
      };
    }
    if (activeOperation(o)) return { ...empty, reason: o!.message };
    if (!["running", "stopped", "gone", "failed"].includes(v.status))
      return {
        ...empty,
        reason: `VM is ${v.status}; wait for a stable state.`,
      };
    if (!online && !["gone", "failed"].includes(v.status))
      return {
        ...empty,
        reason: "The Dummie host is offline. Reconnect it before mutation.",
      };
    const exists = ["running", "stopped"].includes(v.status);
    return {
      ...empty,
      start: online && v.status === "stopped",
      stop: online && v.status === "running",
      remove: online || v.status === "gone" || !v.vm_id,
      edit: exists && online,
      egress: exists && online,
      resize:
        online && v.status === "stopped" && !!v.vm_id && v.boot === "direct",
      reason:
        v.status === "running"
          ? "Stop this plain VM before resizing. Kernel replacement is unavailable in this manager."
          : "",
    };
  }
  async row(
    c: Context,
    v: VM,
    cat: Awaited<ReturnType<Manager["catalogs"]>>,
    ownership?: Ownership,
    o?: Operation | null,
  ): Promise<ManagedVm> {
    const own = ownership ?? (await this.ownership(c, v));
    const operation = o === undefined ? await this.operation(c, v.id) : o;
    const caps = this.capabilities(
      v,
      own,
      operation,
      cat.hosts.some((h) => h.id === v.client_id),
    );
    const busy =
      own.kind === "plain" &&
      (await this.deps.setupBusy?.(c.api.origin, c.account, v.id));
    return {
      id: v.id,
      name: v.name,
      status: v.status,
      cpus: v.cpus || 0,
      memoryMiB: v.memory_mib || 0,
      diskMiB: v.disk_mib || 0,
      ip: v.ip || "",
      boot: v.boot || "",
      defaultUser: v.default_user || "",
      defaultPort: v.default_port || 8000,
      publicPorts: v.public_ports || [],
      hostName:
        cat.hosts.find((h) => h.id === v.client_id)?.hostname ||
        "Host unavailable",
      kernelName:
        cat.kernels.find((k) => k.id === v.kernel_id)?.name || "Not reported",
      kernelId: v.kernel_id || "",
      createdAt: v.created_at || "",
      reportedAt: v.reported_at || "",
      expiresAt: v.expires_at || "",
      error: v.last_error
        ? "Dummie reported an error. Inspect the host logs for details."
        : "",
      management: own.kind,
      retainedDisk: !!own.resource?.adopted,
      bb: own.host
        ? {
            hostId: own.host.id,
            name: own.host.name,
            status: own.host.status,
            phase: own.host.lifecycle.phase,
          }
        : null,
      capabilities: busy
        ? {
            ...caps,
            start: false,
            stop: false,
            remove: false,
            edit: false,
            resize: false,
            egress: false,
            reason:
              "Setup is still running. Wait for it to finish before changing the machine.",
          }
        : caps,
      operation: publicOp(operation),
    };
  }
  async inventory(input: {
    search: string;
    status: string;
    offset: number;
    limit: number;
  }) {
    const c = await this.context();
    const cat = await this.catalogs(c);
    const vms: VM[] = [];
    let total = 0;
    for (let offset = 0; offset < 1000; offset += 100) {
      const page = z
        .object({ items: z.array(vmSchema), total: z.number() })
        .parse(
          await c.api.request("/vms?limit=100&offset=" + offset, c.signal),
        );
      vms.push(...page.items);
      total = page.total;
      if (vms.length >= total || !page.items.length) break;
    }
    let filtered = vms.filter((v) => {
      if (v.created_by !== c.account)
        throw Error("Inventory account mismatch.");
      return (
        (input.status === "all" || v.status === input.status) &&
        v.name.toLowerCase().includes(input.search.toLowerCase())
      );
    });
    const rows = [];
    for (const v of filtered.slice(input.offset, input.offset + input.limit)) {
      let op = await this.operation(c, v.id);
      if (activeOperation(op))
        op = await this.deps.locked("manager-vm:" + v.id, () =>
          this.progress(c, v, op),
        );
      if (op?.action === "remove" && op.state === "complete") continue;
      rows.push(await this.row(c, v, cat, undefined, op));
    }
    const keys = await this.deps.bb.storage.kv.list("manager:create:");
    const requests = [];
    for (const key of keys.slice(-30)) {
      const raw = await this.deps.bb.storage.kv.get(key);
      const r = receiptRecord.parse(raw);
      if (r.account === c.account && r.endpoint === c.api.origin)
        requests.push(publicReceipt(r));
    }
    return {
      vms: rows,
      total: filtered.length,
      scanned: vms.length,
      limited: total > vms.length,
      requests: requests.sort((a, b) => b.createdAt - a.createdAt).slice(0, 10),
    };
  }
  async integrationCatalog() {
    const c = await this.context();
    const list = z.object({ items: z.array(integrationSchema).max(200) });
    const available = list.parse(
      await c.api.request("/integrations", c.signal),
    ).items;
    const details = [];
    for (const item of available)
      details.push(
        integrationSchema.parse(
          await c.api.request(`/integrations/${item.id}`, c.signal),
        ),
      );
    return { origin: c.api.origin, available: details };
  }
  async integrations(id: string) {
    const c = await this.context();
    if (!(await c.api.get(id, c.signal))) throw Error("VM no longer exists.");
    const catalog = await this.integrationCatalog();
    if (catalog.origin !== c.api.origin)
      throw Error("Dummie connection changed. Refresh before continuing.");
    const attached = z
      .object({ items: z.array(integrationSchema).max(200) })
      .parse(
        await c.api.request(
          `/vms/${encodeURIComponent(id)}/integrations`,
          c.signal,
        ),
      ).items;
    return { ...catalog, attached };
  }
  async saveIntegration(input: unknown) {
    const a = integrationEdit.parse(input);
    return this.deps.locked("manager-vm:" + a.id, async () => {
      const { c, v, own } = await this.mutationScope(a.id, a.expectedName);
      if (!["plain", "bb"].includes(own.kind))
        throw Error(
          "Resolve this machine's ownership before changing integrations.",
        );
      if (
        (own.kind === "bb" &&
          !["active", "suspended"].includes(own.host!.lifecycle.phase)) ||
        activeOperation(await this.operation(c, v.id))
      )
        throw Error(
          "Wait for the machine operation to finish before changing integrations.",
        );
      const path = `/integrations/${a.integrationId}`;
      const integration = integrationSchema.parse(
        await c.api.request(path, c.signal),
      );
      if (!integration.connected || integration.suspended)
        throw Error("Connect this integration in Dummie before attaching it.");
      if (integration.kind === "gitlab") {
        if (!a.acceptTokenScope || a.repos.length)
          throw Error(
            "GitLab grants this VM everything the integration token can access. Review and accept that scope before attaching.",
          );
        await c.api.request(`${path}/vms/${v.id}`, c.signal, "POST");
        return {
          message:
            "GitLab integration attached. This VM can access the repositories permitted by its saved token.",
        };
      }
      if (integration.kind !== "github")
        throw Error("Manage this integration type in Dummie.");
      if (!a.repos.length) throw Error("Select at least one repository.");
      const repos = [...new Set(a.repos)];
      if (
        !integration.all_repos &&
        repos.some((r) => !integration.repos.includes(r))
      )
        throw Error(
          "Select repositories covered by this integration. Refresh the list.",
        );
      const current = z
        .object({ items: z.array(integrationSchema) })
        .parse(await c.api.request(`/vms/${v.id}/integrations`, c.signal));
      const wasAttached = current.items.some((i) => i.id === a.integrationId);
      if (!wasAttached)
        await c.api.request(`${path}/vms/${v.id}`, c.signal, "POST");
      try {
        await c.api.request(`${path}/vms/${v.id}/repos`, c.signal, "PUT", {
          repos,
        });
      } catch (error) {
        if (!wasAttached) {
          try {
            await c.api.request(`${path}/vms/${v.id}`, c.signal, "DELETE");
          } catch {
            throw Error(
              "Repository access could not be saved and detachment could not be confirmed. Refresh integrations and detach before retrying.",
            );
          }
        }
        throw error;
      }
      return { message: "Repository access saved for this VM." };
    });
  }
  async detachIntegration(a: {
    id: string;
    expectedName: string;
    integrationId: string;
  }) {
    return this.deps.locked("manager-vm:" + a.id, async () => {
      const { c, v, own } = await this.mutationScope(a.id, a.expectedName);
      if (!["plain", "bb"].includes(own.kind))
        throw Error(
          "Resolve this machine's ownership before changing integrations.",
        );
      if (
        (own.kind === "bb" &&
          !["active", "suspended"].includes(own.host!.lifecycle.phase)) ||
        activeOperation(await this.operation(c, v.id))
      )
        throw Error(
          "Wait for the machine operation to finish before changing integrations.",
        );
      await c.api.request(
        `/integrations/${a.integrationId}/vms/${v.id}`,
        c.signal,
        "DELETE",
      );
      return { message: "Integration detached from this VM." };
    });
  }
  async detail(id: string) {
    return this.deps.locked("manager-vm:" + id, async () => {
      const c = await this.context();
      let v = await c.api.get(id, c.signal);
      let op = await this.progress(c, v, await this.operation(c, id));
      if (op?.action === "remove" && op.state === "complete") v = null;
      if (!v)
        return {
          vm: null,
          targets: [],
          operation: publicOp(op),
          targetCount: 0,
        };
      const [cat, targets] = await Promise.all([
        this.catalogs(c),
        this.targets(c, v),
      ]);
      return {
        vm: await this.row(c, v, cat, undefined, op),
        targets: targets.slice(0, 200),
        targetCount: targets.length,
        operation: publicOp(op),
      };
    });
  }
  async mutationScope(id: string, name: string) {
    const c = await this.context();
    const v = await c.api.get(id, c.signal);
    if (!v) throw Error("VM no longer exists. Refresh inventory.");
    if (v.name !== name)
      throw Error("VM name changed. Refresh before making changes.");
    if (await this.deps.setupBusy?.(c.api.origin, c.account, id))
      throw Error(
        "Setup is still running. Wait for it to finish before changing the machine.",
      );
    const own = await this.ownership(c, v);
    const op = await this.progress(c, v, await this.operation(c, id));
    const cat = await this.catalogs(c);
    const caps = this.capabilities(
      v,
      own,
      op,
      cat.hosts.some((h) => h.id === v.client_id),
    );
    return { c, v, own, caps };
  }
  async enroll(input: unknown) {
    const a = identity.parse(input);
    return this.deps.locked("manager-vm:" + a.id, async () => {
      const { c, v, own } = await this.mutationScope(a.id, a.expectedName);
      if (own.kind === "bb")
        return {
          hostId: own.host!.id,
          message: "This VM is already connected to BB.",
        };
      if (
        own.kind !== "plain" ||
        activeOperation(await this.operation(c, v.id)) ||
        v.expires_at ||
        !["running", "stopped"].includes(v.status)
      )
        throw Error(
          "Only an untracked, persistent, running or stopped VM with no pending operation can be enrolled.",
        );
      // Core owns enrollment and deduplicates a lost response with this stable key.
      const retired = (await this.deps.resources())
        .filter(
          (r) =>
            r.adopted &&
            r.phase === "removed" &&
            r.endpoint === c.api.origin &&
            r.account === c.account &&
            r.vmId === v.id,
        )
        .map((r) => r.key)
        .sort();
      const key =
        "dummie-adopt-" + hash([c.api.origin, c.account, v.id, retired]);
      const host = await this.deps.bb.sdk.hosts.experimental_create({
        machineProviderId: "dummie",
        key,
        inputs: {
          existingVmId: v.id,
          expectedName: v.name,
          connection: c.cfg.connection ?? "remote",
        },
        wait: false,
      });
      return {
        hostId: host.id,
        message:
          "BB enrollment started. The existing VM and disk will be retained.",
      };
    });
  }
  async perform(
    c: Context,
    v: VM,
    action: string,
    desired: Operation["desired"],
    method: string,
    path: string,
    body?: unknown,
  ) {
    let op: Operation = {
      vmId: v.id,
      name: v.name,
      account: c.account,
      endpoint: c.api.origin,
      action,
      state: "pending",
      message: "Request submitted; waiting for Dummie confirmation.",
      startedAt: Date.now(),
      stage: "posting",
      desired,
    };
    await this.putOp(c, op);
    try {
      await c.api.request(path, c.signal, method, body);
      if (!["start", "stop", "remove"].includes(action)) {
        op = {
          ...op,
          state: "complete",
          message: "Change accepted by Dummie.",
        };
        await this.putOp(c, op);
      }
      return { message: op.message };
    } catch (e) {
      const rejected =
        e instanceof ApiError && e.status >= 400 && e.status < 500;
      op = {
        ...op,
        state: rejected ? "failed" : "uncertain",
        message: rejected
          ? `Dummie rejected the change (HTTP ${(e as ApiError).status}). Refresh and review state/quota before retrying.`
          : "Response uncertain. Refresh to reconcile before any further writes; no duplicate request will be sent.",
      };
      await this.putOp(c, op);
      if (rejected) throw Error(op.message);
      return { message: op.message };
    }
  }
  async action(input: unknown) {
    const a = actionSchema.parse(input);
    return this.deps.locked("manager-vm:" + a.id, async () => {
      const { c, v, own, caps } = await this.mutationScope(
        a.id,
        a.expectedName,
      );
      if (
        ["remove", "retryCleanup"].includes(a.action) &&
        a.confirmation !== v.name
      )
        throw Error("Type the exact VM name to confirm permanent disk loss.");
      if (!caps[a.action])
        throw Error(
          caps.reason || "Action is unavailable in the current state.",
        );
      if (own.kind === "bb") {
        const hostId = own.host!.id;
        if (["remove", "retryCleanup"].includes(a.action)) {
          const r = resourceSchema.parse(
            await this.deps.bb.experimental_machines.getResource(hostId),
          );
          if (
            r.vmId !== v.id ||
            r.name !== v.name ||
            r.account !== c.account ||
            r.endpoint !== c.api.origin ||
            r.owner !== this.deps.owner
          )
            throw Error("BB resource identity changed; removal refused.");
          await this.deps.bb.storage.kv.set("remove-approved:" + r.key, true);
        }
        if (a.action === "start")
          await this.deps.bb.sdk.hosts.experimental_resume({ hostId });
        else if (a.action === "stop")
          await this.deps.bb.sdk.hosts.experimental_suspend({ hostId });
        else if (a.action === "reconcile")
          await this.deps.bb.sdk.hosts.experimental_reconcile({ hostId });
        else if (a.action === "retryCleanup")
          await this.deps.bb.sdk.hosts.experimental_retryCleanup({ hostId });
        else await this.deps.bb.sdk.hosts.delete({ hostId });
        return {
          message:
            "BB accepted the lifecycle request. Waiting for core completion.",
        };
      }
      if (a.action === "remove") {
        if (v.status === "gone" || !v.vm_id)
          return this.perform(
            c,
            v,
            "remove",
            { status: "removed" },
            "DELETE",
            "/vms/" + v.id,
          );
        return this.perform(
          c,
          v,
          "remove",
          { status: "removed" },
          "POST",
          "/vms/" + v.id + "/destroy",
        );
      }
      return this.perform(
        c,
        v,
        a.action,
        { status: a.action === "start" ? "running" : "stopped" },
        "POST",
        "/vms/" + v.id + "/" + a.action,
      );
    });
  }
  async edit(input: unknown) {
    const a = editSchema.parse(input);
    return this.deps.locked("manager-vm:" + a.id, async () => {
      const { c, v, own, caps } = await this.mutationScope(
        a.id,
        a.expectedName,
      );
      if (
        own.kind !== "plain" ||
        !(a.kind === "size" ? caps.resize : caps.edit)
      )
        throw Error(caps.reason || "Configuration editing is unavailable.");
      if (a.kind === "size") {
        if (diskMiB(a.disk) < (v.disk_mib || 0))
          throw Error("Disk shrinking is not supported.");
        const q = await this.quota(c);
        if (
          q.vcpu_used - (v.cpus || 0) + a.cpus > q.vcpu_limit ||
          q.memory_used_mib - (v.memory_mib || 0) + a.memoryMiB >
            q.memory_limit_mib ||
          q.disk_used_mib - (v.disk_mib || 0) + diskMiB(a.disk) >
            q.disk_limit_mib
        )
          throw Error("The requested size exceeds account quota.");
        return this.perform(
          c,
          v,
          "size",
          { cpus: a.cpus, memory_mib: a.memoryMiB, disk_mib: diskMiB(a.disk) },
          "PUT",
          "/vms/" + v.id + "/size",
          { cpus: a.cpus, memory_mib: a.memoryMiB, disk_size: a.disk },
        );
      }
      if (a.kind === "user")
        return this.perform(
          c,
          v,
          "user",
          { default_user: a.defaultUser },
          "PUT",
          "/vms/" + v.id + "/user",
          { default_user: a.defaultUser },
        );
      const ports = [...new Set(a.publicPorts)];
      return this.perform(
        c,
        v,
        "ports",
        { default_port: a.defaultPort, public_ports: ports },
        "PUT",
        "/vms/" + v.id + "/ports",
        { default_port: a.defaultPort, public_ports: ports },
      );
    });
  }
  async saveTarget(input: {
    id: string;
    expectedName: string;
    targetId?: string;
    rule: Rule;
  }) {
    const a = {
      ...identity.parse({ id: input.id, expectedName: input.expectedName }),
      rule: ruleSchema.parse(input.rule),
      targetId: input.targetId,
    };
    return this.deps.locked("manager-vm:" + a.id, async () => {
      const { c, v, own, caps } = await this.mutationScope(
        a.id,
        a.expectedName,
      );
      if (own.kind !== "plain" || !caps.egress)
        throw Error(caps.reason || "Egress editing is unavailable.");
      if (
        a.targetId &&
        !(await this.targets(c, v)).some((r) => r.id === a.targetId)
      )
        throw Error("Egress rule no longer exists. Refresh before editing.");
      return this.perform(
        c,
        v,
        a.targetId ? "target-edit" : "target-add",
        {
          destination: apiRule(a.rule).destination,
          kind: a.rule.kind,
          transport: a.rule.kind === "domain" ? "tcp" : a.rule.transport,
          ports: apiRule(a.rule).ports,
          note: a.rule.note,
        },
        a.targetId ? "PUT" : "POST",
        "/vms/" + v.id + "/targets" + (a.targetId ? "/" + a.targetId : ""),
        apiRule(a.rule),
      );
    });
  }
  async removeTarget(input: {
    id: string;
    expectedName: string;
    targetId: string;
    confirmation: string;
  }) {
    return this.deps.locked("manager-vm:" + input.id, async () => {
      const { c, v, own, caps } = await this.mutationScope(
        input.id,
        input.expectedName,
      );
      if (own.kind !== "plain" || !caps.egress)
        throw Error(caps.reason || "Egress editing is unavailable.");
      const target = (await this.targets(c, v)).find(
        (t) => t.id === input.targetId,
      );
      if (!target) throw Error("Rule no longer exists.");
      if (input.confirmation !== target.rule.destination)
        throw Error(
          "Confirm the exact destination before removing its access.",
        );
      return this.perform(
        c,
        v,
        "target-remove",
        { targetId: target.id },
        "DELETE",
        "/vms/" + v.id + "/targets/" + target.id,
      );
    });
  }
  async create(input: unknown) {
    const a = createSchema.parse(input);
    return this.deps.locked("manager-create:" + a.key, async () => {
      const c = await this.context();
      const key = "manager:create:" + a.key;
      let r: Receipt | undefined;
      const stored = await this.deps.bb.storage.kv.get(key);
      const fingerprint = hash(a);
      if (stored) {
        r = receiptRecord.parse(stored);
        this.assertReceipt(c, r);
        if (r.fingerprint !== fingerprint)
          throw Error(
            "This request key already has different inputs. Check the original request before starting a new one.",
          );
        if (r.state === "confirmed") return publicReceipt(r);
        if (r.state === "rejected") throw Error(r.message);
        if (r.mode === "plain" && r.state === "posting")
          return this.reconcileReceipt(c, r);
      }
      if (a.mode === "bb" && a.profile.memoryMiB < 1024)
        throw Error("BB enrollment requires at least 1024 MiB RAM.");
      if (c.cfg.hostNetworkNotice && !a.acknowledgeHostNotice)
        throw Error(
          "Review and acknowledge the host networking prerequisite before allocating.",
        );
      if (!r) {
        await this.checkProfile(c, a.profile);
        const recipe = a.recipeId
          ? await this.deps.getRecipe?.(a.recipeId, a.recipeRevision)
          : undefined;
        if (a.recipeId && !recipe) throw Error("Recipe support unavailable.");
        if (recipe && recipe.mode !== a.mode)
          throw Error("Management mode differs from the selected recipe.");
        if (recipe) await checkRecipeIntegrations(c.api, recipe, c.signal);
        const name = a.name || friendlyName(c.api.origin + c.account, a.key);
        if ((await c.api.list(c.signal)).some((v) => v.name === name))
          throw Error(
            "That VM name already exists. Choose another name; nothing was created.",
          );
        const body = {
          client_id: a.profile.host,
          kernel_id: a.profile.kernel,
          osimage_id: a.profile.image,
          cpus: a.profile.cpus,
          memory_mib: a.profile.memoryMiB,
          disk_size: a.profile.disk,
          targets: a.profile.targets.map(apiRule),
          ttl_seconds: 0,
          name,
        };
        r = {
          key: a.key,
          mode: a.mode,
          name,
          state: "prepared",
          message: "Allocation intent recorded.",
          account: c.account,
          endpoint: c.api.origin,
          fingerprint,
          body,
          createdAt: Date.now(),
          ...(recipe ? { recipe } : {}),
        };
        if (recipe && a.mode === "bb")
          await this.deps.pinRecipe?.("dummie-manager-" + a.key, recipe);
        await this.deps.bb.storage.kv.set(key, r);
      }
      r = {
        ...r,
        state: "posting",
        message: "Allocation submitted; confirmation pending.",
      };
      await this.deps.bb.storage.kv.set(key, r);
      try {
        if (a.mode === "bb") {
          const host = await this.deps.bb.sdk.hosts.experimental_create({
            machineProviderId: "dummie",
            key: "dummie-manager-" + a.key,
            inputs: {
              name: r.name,
              ...(r.recipe
                ? { recipeId: r.recipe.id, recipeRevision: r.recipe.revision }
                : {}),
              connection: c.cfg.connection ?? "remote",
              host: a.profile.host,
              kernel: a.profile.kernel,
              image: a.profile.image,
              cpus: a.profile.cpus,
              memoryMiB: a.profile.memoryMiB,
              disk: a.profile.disk,
              targets: a.profile.targets.map(apiRule),
            },
            wait: false,
          });
          r = {
            ...r,
            state: "confirmed",
            hostId: host.id,
            name: r.name,
            message:
              "BB launch accepted. Enrollment and readiness are still in progress.",
          };
        } else {
          const vm = vmSchema.parse(
            await c.api.request("/vms", c.signal, "POST", r.body),
          );
          if (
            vm.created_by !== c.account ||
            vm.name !== r.name ||
            vm.client_id !== r.body.client_id
          )
            throw Error("Created VM identity did not match intent.");
          r = {
            ...r,
            state: "confirmed",
            vmId: vm.id,
            message: "Dummie VM allocated. Guest readiness is still pending.",
          };
          // Allocation is confirmed before any optional setup scheduling.
          await this.deps.bb.storage.kv.set(key, r);
          if (
            r.recipe?.bootstrapScript.trim() ||
            r.recipe?.integrations?.length
          ) {
            try {
              await this.deps.queueRecipe?.(
                vm,
                r.recipe,
                c.cfg,
                c.api.origin,
                c.account,
              );
              r.message =
                "Machine created. Setup is queued; follow its progress on the machine page.";
            } catch {
              r.message =
                "Machine created, but setup could not be queued. Check this request again to retry setup. No new machine is needed.";
            }
          }
        }
        await this.deps.bb.storage.kv.set(key, r);
        return publicReceipt(r);
      } catch (e) {
        if (r.state === "confirmed")
          return publicReceipt({
            ...r,
            message:
              "Machine created. Check its page for setup progress; no new machine is needed.",
          });
        if (
          e instanceof ApiError &&
          [400, 401, 403, 404, 422].includes(e.status)
        )
          r = {
            ...r,
            state: "rejected",
            message: `Create rejected before allocation (HTTP ${e.status}). Review quota/catalog and explicitly start a new request.`,
          };
        else
          r = {
            ...r,
            state: "posting",
            message:
              "Allocation outcome is uncertain. Check this request before starting another; no duplicate plain create will be sent.",
          };
        await this.deps.bb.storage.kv.set(key, r);
        return publicReceipt(r);
      }
    });
  }
  assertReceipt(c: Context, r: Receipt) {
    if (r.endpoint !== c.api.origin || r.account !== c.account)
      throw Error(
        "Request belongs to another account/control endpoint. Restore the original connection.",
      );
  }
  async reconcileReceipt(c: Context, r: Receipt) {
    this.assertReceipt(c, r);
    if (
      r.mode === "plain" &&
      r.state === "confirmed" &&
      r.vmId &&
      (r.recipe?.bootstrapScript.trim() || r.recipe?.integrations?.length)
    ) {
      const vm = await c.api.get(r.vmId, c.signal);
      if (
        !vm ||
        vm.name !== r.name ||
        vm.created_by !== c.account ||
        vm.client_id !== r.body.client_id
      )
        throw Error("Created machine identity changed; setup was not queued.");
      try {
        await this.deps.queueRecipe?.(
          vm,
          r.recipe,
          c.cfg,
          c.api.origin,
          c.account,
        );
        r = {
          ...r,
          message: "Machine created. Setup queued; open its page for progress.",
        };
      } catch {
        r = {
          ...r,
          message:
            "Machine created. Setup could not be queued; restore the connection and check this request again.",
        };
      }
      await this.deps.bb.storage.kv.set("manager:create:" + r.key, r);
    }
    if (r.mode === "bb" && r.state === "posting") {
      try {
        const p = profileSchema.parse({
          host: r.body.client_id,
          kernel: r.body.kernel_id,
          image: r.body.osimage_id,
          cpus: r.body.cpus,
          memoryMiB: r.body.memory_mib,
          disk: r.body.disk_size,
          targets: (r.body.targets as unknown[]).map(ruleFromApi),
        });
        const host = await this.deps.bb.sdk.hosts.experimental_create({
          machineProviderId: "dummie",
          key: "dummie-manager-" + r.key,
          inputs: {
            ...(vmName.safeParse(r.body.name).success
              ? { name: r.body.name }
              : {}),
            ...(r.recipe
              ? { recipeId: r.recipe.id, recipeRevision: r.recipe.revision }
              : {}),
            connection: c.cfg.connection ?? "remote",
            host: p.host,
            kernel: p.kernel,
            image: p.image,
            cpus: p.cpus,
            memoryMiB: p.memoryMiB,
            disk: p.disk,
            targets: p.targets.map(apiRule),
          },
          wait: false,
        });
        r = {
          ...r,
          state: "confirmed",
          hostId: host.id,
          name: host.name,
          message:
            "Original BB launch recovered using its stable core key. Check core provisioning for readiness.",
        };
        await this.deps.bb.storage.kv.set("manager:create:" + r.key, r);
      } catch {
        r = {
          ...r,
          message:
            "Original BB launch is still unconfirmed. No new key was used; inspect BB provisioning before retrying.",
        };
      }
    }
    if (r.mode === "plain" && r.state === "posting") {
      const matches = (await c.api.list(c.signal)).filter(
        (v) => v.name === r.name,
      );
      const v = matches.length === 1 ? matches[0] : undefined;
      if (
        v &&
        v.created_by === c.account &&
        v.client_id === r.body.client_id &&
        v.cpus === r.body.cpus &&
        v.memory_mib === r.body.memory_mib &&
        v.kernel_id === r.body.kernel_id &&
        v.disk_mib === diskMiB(String(r.body.disk_size)) &&
        v.created_at &&
        Date.parse(v.created_at) >= r.createdAt - 5000
      ) {
        r = {
          ...r,
          state: "confirmed",
          vmId: v.id,
          message:
            "Previously uncertain allocation found by exact name and matching account, host, size, kernel and creation time.",
        };
        await this.deps.bb.storage.kv.set("manager:create:" + r.key, r);
        if (r.recipe?.bootstrapScript.trim() || r.recipe?.integrations?.length)
          await this.deps.queueRecipe?.(
            v,
            r.recipe,
            c.cfg,
            c.api.origin,
            c.account,
          );
      }
    }
    return publicReceipt(r);
  }
  async request(key: string) {
    return this.deps.locked("manager-create:" + key, async () => {
      const c = await this.context();
      const raw = await this.deps.bb.storage.kv.get("manager:create:" + key);
      if (!raw) throw Error("Request not found.");
      return this.reconcileReceipt(c, receiptRecord.parse(raw));
    });
  }
}
