import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import { Api, ApiError, type VM } from "./api.js";

export const networkSelector = z.union([
  z.object({ vmId: z.string().uuid() }).strict(),
  z.object({ threadId: z.string().min(1).max(100) }).strict(),
]);
export type NetworkSelector = z.infer<typeof networkSelector>;
const ttl = z.union([z.literal(300), z.literal(3600), z.literal(86400)]);
const webPorts = z.enum(["443", "80,443"]);
const block = z.object({
  kind: z.string().max(40),
  domain: z.string().max(253).default(""),
  address: z.string().max(100).default(""),
  proto: z.string().max(20).default(""),
  port: z.number().int().min(0).max(65535).default(0),
  attempts: z.number().nonnegative(),
  last_seen: z.string().max(100),
});
const denied = z.object({
  available: z.boolean(),
  items: z.array(block).max(5000),
  recording: z.object({ packets: z.boolean(), lookups: z.boolean() }),
});
const target = z.object({
  id: z.string().max(100),
  kind: z.string(),
  destination: z.string(),
  ports: z.string().default(""),
  note: z.string().default(""),
  expires_at: z.string().default(""),
});
export const networkStatus = z.object({
  vmId: z.string(),
  name: z.string(),
  available: z.boolean(),
  canManage: z.boolean(),
  recording: z.object({ packets: z.boolean(), lookups: z.boolean() }),
  limited: z.boolean(),
  blocks: z.array(
    z.object({
      key: z.string(),
      destination: z.string(),
      kind: z.string(),
      port: z.number(),
      attempts: z.number(),
      lastSeen: z.string(),
      canAllow: z.boolean(),
      allowed: z.boolean(),
    }),
  ),
  grants: z.array(
    z.object({
      id: z.string(),
      destination: z.string(),
      ports: z.string(),
      expiresAt: z.string(),
    }),
  ),
});
export const networkMethods = {
  network_status: { input: networkSelector, output: networkStatus.nullable() },
  network_allow: {
    input: z
      .object({
        selector: networkSelector,
        expectedName: z.string().min(1).max(52),
        blockKey: z.string().length(64),
        ttlSeconds: ttl,
        ports: webPorts,
      })
      .strict(),
    output: z.object({ message: z.string() }),
  },
  network_revoke: {
    input: z
      .object({
        selector: networkSelector,
        expectedName: z.string().min(1).max(52),
        grantId: z.string().uuid(),
      })
      .strict(),
    output: z.object({ message: z.string() }),
  },
};
export type NetworkScope = {
  api: Api;
  account: string;
  vm: VM;
  signal: AbortSignal;
  canManage: boolean;
};
type Kv = {
  get(key: string): Promise<unknown>;
  set(key: string, value: any): Promise<void>;
  list(prefix: string): Promise<string[]>;
};
const receipt = z.object({
  id: z.string().uuid(),
  destination: z.string(),
  ports: webPorts,
  createdAt: z.number(),
  ttlSeconds: ttl,
  state: z.enum(["pending", "complete", "failed", "revoked"]),
});
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const normal = (s: string) => s.toLowerCase().replace(/\.$/, "");
const domain = (s: string) =>
  s.length <= 253 &&
  !isIP(s) &&
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(
    s,
  );
const key = (b: z.infer<typeof block>) =>
  hash([b.kind, normal(b.domain), b.address, b.proto, b.port]);
const active = (t: z.infer<typeof target>) =>
  !t.expires_at || Date.parse(t.expires_at) > Date.now();
const matches = (t: z.infer<typeof target>, name: string, port: number) =>
  t.kind === "domain" &&
  active(t) &&
  (name === normal(t.destination) ||
    name.endsWith("." + normal(t.destination))) &&
  (t.ports || "80,443").split(",").includes(String(port));

export class NetworkAccess {
  constructor(readonly kv: Kv) {}
  prefix(s: NetworkScope) {
    return "network:grant:" + hash([s.api.origin, s.account, s.vm.id]) + ":";
  }
  async records(s: NetworkScope) {
    const keys = await this.kv.list(this.prefix(s));
    if (keys.length > 1000)
      throw Error("Too many network access records. Review access in Dummie.");
    return Promise.all(
      keys.map(async (k) => receipt.parse(await this.kv.get(k))),
    );
  }
  async read(s: NetworkScope) {
    if (s.vm.created_by !== s.account)
      throw Error("VM does not belong to this account.");
    const [blocks, targets] = await Promise.all([
      s.api.request(`/vms/${s.vm.id}/denied?seconds=3600`, s.signal),
      s.api.request(`/vms/${s.vm.id}/targets`, s.signal),
    ]);
    return {
      denied: denied.parse(blocks),
      targets: z.object({ items: z.array(target).max(1000) }).parse(targets)
        .items,
    };
  }
  async status(s: NetworkScope) {
    const r = await this.read(s);
    const records = await this.records(s);
    return networkStatus.parse({
      vmId: s.vm.id,
      name: s.vm.name,
      available: r.denied.available,
      canManage: s.canManage,
      recording: r.denied.recording,
      limited: r.denied.items.length > 200,
      blocks: r.denied.items
        .sort((a, b) => Date.parse(b.last_seen) - Date.parse(a.last_seen))
        .slice(0, 200)
        .map((b) => {
          const name = normal(b.domain);
          return {
            key: key(b),
            destination: name || b.address,
            kind: b.kind,
            port: b.port,
            attempts: b.attempts,
            lastSeen: b.last_seen,
            canAllow:
              s.canManage &&
              r.denied.available &&
              domain(name) &&
              (b.kind === "lookup" || b.port === 80 || b.port === 443),
            allowed:
              !!name && r.targets.some((t) => matches(t, name, b.port || 443)),
          };
        }),
      grants: records
        .filter((g) => g.state !== "revoked" && g.state !== "failed")
        .flatMap((g) => {
          const t = r.targets.find(
            (t) =>
              t.note === "BB network access " + g.id &&
              t.destination === g.destination &&
              t.ports === g.ports &&
              active(t),
          );
          return t
            ? [
                {
                  id: g.id,
                  destination: g.destination,
                  ports: g.ports,
                  expiresAt: t.expires_at,
                },
              ]
            : [];
        }),
    });
  }
  async allow(
    s: NetworkScope,
    input: z.infer<typeof networkMethods.network_allow.input>,
  ) {
    if (!s.canManage || s.vm.name !== input.expectedName)
      throw Error(
        "Machine changed or access is unavailable. Refresh before allowing it.",
      );
    const r = await this.read(s);
    if (!r.denied.available)
      throw Error("Dummie is not reporting blocked destinations.");
    const b = r.denied.items.find((b) => key(b) === input.blockKey);
    const name = normal(b?.domain || "");
    if (
      !b ||
      !domain(name) ||
      !(b.kind === "lookup" || b.port === 80 || b.port === 443)
    )
      throw Error(
        "This web destination is no longer in Dummie's recent block log. Retry the request and refresh.",
      );
    if (
      input.ports
        .split(",")
        .every((p) => r.targets.some((t) => matches(t, name, Number(p))))
    )
      return {
        message:
          "This destination already has access. Retry the page or command.",
      };
    const pending = (await this.records(s)).find(
      (g) =>
        g.state === "pending" &&
        g.destination === name &&
        g.ports === input.ports &&
        Date.now() < g.createdAt + g.ttlSeconds * 1000,
    );
    if (pending)
      throw Error(
        "An earlier access request is still unconfirmed. Refresh or check Dummie before trying again.",
      );
    const g = receipt.parse({
      id: randomUUID(),
      destination: name,
      ports: input.ports,
      createdAt: Date.now(),
      ttlSeconds: input.ttlSeconds,
      state: "pending",
    });
    const storageKey = this.prefix(s) + g.id;
    await this.kv.set(storageKey, g);
    try {
      await s.api.request(`/vms/${s.vm.id}/targets`, s.signal, "POST", {
        kind: "domain",
        destination: name,
        transport: "tcp",
        ports: input.ports,
        note: "BB network access " + g.id,
        ttl_seconds: input.ttlSeconds,
      });
    } catch (e) {
      if (
        e instanceof ApiError &&
        e.status >= 400 &&
        e.status < 500 &&
        e.status !== 409
      ) {
        await this.kv.set(storageKey, { ...g, state: "failed" });
        throw Error(
          `Dummie rejected access (HTTP ${e.status}). No access was confirmed.`,
        );
      }
      // A lost reply must be reconciled by observing the unique receipt, never by reposting.
    }
    const refreshed = await this.read(s);
    const saved = refreshed.targets.find(
      (t) =>
        t.note === "BB network access " + g.id &&
        t.destination === name &&
        t.ports === input.ports,
    );
    if (!saved)
      throw Error(
        "Access is not yet confirmed. Refresh or check Dummie before retrying.",
      );
    const expiry = Date.parse(saved.expires_at);
    if (
      !Number.isFinite(expiry) ||
      expiry <= Date.now() ||
      expiry > g.createdAt + g.ttlSeconds * 1000 + 60000
    ) {
      await s.api.request(
        `/vms/${s.vm.id}/targets/${encodeURIComponent(saved.id)}`,
        s.signal,
        "DELETE",
      );
      if ((await this.read(s)).targets.some((t) => t.id === saved.id))
        throw Error(
          "Dummie did not confirm the requested expiry or removal. Remove this allowance in Dummie before retrying.",
        );
      await this.kv.set(storageKey, { ...g, state: "failed" });
      throw Error(
        "Dummie did not confirm the requested expiry. The new allowance was removed.",
      );
    }
    await this.kv.set(storageKey, { ...g, state: "complete" });
    return {
      message: "Temporary access confirmed. Retry the page or command.",
    };
  }
  async revoke(
    s: NetworkScope,
    input: z.infer<typeof networkMethods.network_revoke.input>,
  ) {
    if (!s.canManage || s.vm.name !== input.expectedName)
      throw Error("Machine changed. Refresh before removing access.");
    const raw = await this.kv.get(this.prefix(s) + input.grantId);
    if (!raw) throw Error("This allowance was not created here.");
    const g = receipt.parse(raw);
    const r = await this.read(s);
    const t = r.targets.find(
      (t) =>
        t.note === "BB network access " + g.id &&
        t.destination === g.destination &&
        t.ports === g.ports,
    );
    if (t) {
      await s.api.request(
        `/vms/${s.vm.id}/targets/${encodeURIComponent(t.id)}`,
        s.signal,
        "DELETE",
      );
      if ((await this.read(s)).targets.some((row) => row.id === t.id))
        throw Error(
          "Access removal is not confirmed. Refresh before retrying.",
        );
    }
    await this.kv.set(this.prefix(s) + g.id, { ...g, state: "revoked" });
    return { message: "Temporary access removed." };
  }
}
