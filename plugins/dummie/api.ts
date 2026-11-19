import { z } from "zod";
export const vmSchema = z.object({
  id: z.string(),
  name: z.string(),
  client_id: z.string(),
  created_by: z.string(),
  status: z.string(),
  vm_id: z.string().default(""),
  expires_at: z.string().default(""),
  cpus: z.number().optional(),
  memory_mib: z.number().optional(),
  disk_mib: z.number().optional(),
  boot: z.string().optional(),
  ip: z.string().optional(),
  default_user: z.string().optional(),
  default_port: z.number().optional(),
  public_ports: z.array(z.number()).optional(),
  kernel_id: z.string().optional(),
  created_at: z.string().optional(),
  started_at: z.string().optional(),
  reported_at: z.string().optional(),
  last_error: z.string().optional(),
});
export type VM = z.infer<typeof vmSchema>;
export class TransientError extends Error {}
type QuotaFailure = {
  resource: "vCPU" | "memory MiB" | "disk MiB";
  total: string;
  limit: string;
  used: string;
};
function quotaFailure(raw: string): QuotaFailure | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    const parsed = z.object({ message: z.string().max(500) }).safeParse(value);
    if (!parsed.success) return;
    const cpu =
      /^this would use (\d{1,15}) vCPU of your (\d{1,15}) limit; you are already using (\d{1,15})$/.exec(
        parsed.data.message,
      );
    if (cpu)
      return {
        resource: "vCPU",
        total: cpu[1]!,
        limit: cpu[2]!,
        used: cpu[3]!,
      };
    const size =
      /^this would use (\d{1,15}) MiB of (memory|disk) against your (\d{1,15}) MiB limit; you are already using (\d{1,15}) MiB$/.exec(
        parsed.data.message,
      );
    if (size)
      return {
        resource: size[2] === "memory" ? "memory MiB" : "disk MiB",
        total: size[1]!,
        limit: size[3]!,
        used: size[4]!,
      };
  } catch {
    // Only recognize the control server's numeric quota errors. Never echo an arbitrary response.
  }
}
async function readQuotaFailure(
  response: Response,
): Promise<QuotaFailure | undefined> {
  if (response.status !== 403 || !response.body) {
    await response.body?.cancel();
    return;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) return;
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return quotaFailure(new TextDecoder().decode(body));
  } catch {
    return;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export class ApiError extends Error {
  constructor(
    public status: number,
    quota?: QuotaFailure,
  ) {
    super(
      quota
        ? `Dummie ${quota.resource} quota exceeded: already using ${quota.used} of ${quota.limit}; this request would use ${quota.total}. Use an existing machine or adjust the local account quota. Stopping a VM does not release its quota.`
        : `Dummie API returned HTTP ${status}. Check account permissions and control service logs.`,
    );
  }
}
export function endpoint(raw: string) {
  const u = new URL(raw);
  if (u.username || u.password || u.search || u.hash || u.pathname !== "/")
    throw Error("Control URL must be an origin without credentials or path.");
  if (
    u.protocol !== "https:" &&
    !(
      u.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
    )
  )
    throw Error("Use HTTPS except for a loopback control server.");
  return u.origin;
}
export class Api {
  constructor(
    public origin: string,
    private token: string,
    private transport?: (
      path: string,
      signal: AbortSignal,
      method: string,
      body?: unknown,
    ) => Promise<unknown>,
  ) {
    this.origin = endpoint(origin);
  }
  async request(
    path: string,
    signal: AbortSignal,
    method = "GET",
    body?: unknown,
  ): Promise<unknown> {
    signal.throwIfAborted();
    if (this.transport) return this.transport(path, signal, method, body);
    let r: Response;
    try {
      r = await fetch(this.origin + "/api/v1" + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        redirect: "error",
      });
    } catch {
      signal.throwIfAborted();
      throw new TransientError(
        "Dummie control request failed or timed out. Check the endpoint and local services.",
      );
    }
    if (!r.ok) {
      throw new ApiError(r.status, await readQuotaFailure(r));
    }
    if (r.status === 204) return null;
    const raw = await r.text();
    if (raw.length > 2_000_000) throw Error("Dummie response exceeded 2 MB.");
    try {
      return JSON.parse(raw);
    } catch {
      throw Error("Dummie returned invalid JSON.");
    }
  }
  async account(signal: AbortSignal) {
    return z.object({ id: z.string() }).parse(await this.request("/me", signal))
      .id;
  }
  async list(signal: AbortSignal): Promise<VM[]> {
    const result: VM[] = [];
    for (let offset = 0; offset < 10000; offset += 100) {
      const page = z
        .object({ items: z.array(vmSchema), total: z.number() })
        .parse(await this.request(`/vms?limit=100&offset=${offset}`, signal));
      result.push(...page.items);
      if (result.length >= page.total) return result;
      if (page.items.length === 0) break;
    }
    throw Error(
      "VM reconciliation exceeded 10,000 records; refusing an incomplete lookup.",
    );
  }
  async get(id: string, signal: AbortSignal) {
    try {
      return vmSchema.parse(
        await this.request("/vms/" + encodeURIComponent(id), signal),
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }
  async choices(kind: "hosts" | "kernels" | "osimages", signal: AbortSignal) {
    const raw = await this.request("/vms/" + kind, signal);
    return z
      .object({
        items: z.array(
          z.object({
            id: z.string(),
            name: z.string().optional(),
            hostname: z.string().optional(),
            description: z.string().optional(),
            size_bytes: z.number().optional(),
            created_at: z.string().optional(),
            source: z.string().optional(),
            oci_ref: z.string().optional(),
            file_name: z.string().optional(),
            default_port: z.number().optional(),
          }),
        ),
      })
      .parse(raw)
      .items.slice(0, 200);
  }
}
export async function pause(signal: AbortSignal, ms = 1500) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      clearTimeout(t);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      done();
      reject(signal.reason);
    };
    const t = setTimeout(() => {
      done();
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
