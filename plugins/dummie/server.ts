import {
  checkRecipeIntegrations,
  attachRecipeIntegrations,
} from "./recipe-integrations.js";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  NetworkAccess,
  networkMethods,
  type NetworkSelector,
} from "./network.js";
import { remoteSchema, remoteInput, remoteList } from "./remotes.js";
import { Api, endpoint, pause } from "./api.js";
import {
  Lifecycle,
  choicesSchema,
  resourceSchema,
  newOwner,
  type Resource,
  targetsSchema,
} from "./lifecycle.js";
import { sshExecutor, prerequisites } from "./executor.js";
import { createHostRouting } from "./host-client.js";
import { Manager, apiRule } from "./manager.js";
import { managerMethods } from "./manager-contract.js";
import { friendlyName } from "./names.js";
import {
  recipeSchema,
  setupRunSchema,
  type Recipe,
} from "./manager-contract.js";
import {
  Recipes,
  RecipeRunner,
  setupScope,
  digest,
  bootstrapTargets,
} from "./recipes.js";
const checkSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  detail: z.string(),
});
const choice = z.object({
  id: z.string(),
  name: z.string().optional(),
  hostname: z.string().optional(),
});
const publicIntent = z.object({
  name: z.string(),
  phase: z.string(),
  vmId: z.string().optional(),
  enrolled: z.boolean(),
  transferred: z.boolean(),
});
const safeIntent = (r: Resource) => ({
  name: r.name,
  phase: r.phase,
  vmId: r.vmId || "",
  enrolled: !!r.enrolled,
  transferred: !!r.transferredTo,
});
export const rpcContract = defineRpcContract({
  execution_machines: {
    input: z.null(),
    output: z.array(
      z.object({ id: z.string(), name: z.string(), status: z.string() }),
    ),
  },
  ...managerMethods,
  ...networkMethods,
  suggest_name: {
    input: z.object({ key: z.string().uuid() }).strict(),
    output: z.object({ name: z.string() }),
  },
  connections: {
    input: z.null(),
    output: z.object({
      active: z.string(),
      profiles: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          origin: z.string(),
          credentialsConfigured: z.boolean(),
        }),
      ),
    }),
  },
  select_connection: {
    input: z.object({ connection: z.string().min(1).max(80) }).strict(),
    output: z.object({ saved: z.literal(true) }),
  },
  save_connection: {
    input: remoteInput,
    output: z.object({ id: z.string() }),
  },
  connection_details: {
    input: z.object({ id: z.string() }).strict(),
    output: remoteSchema
      .omit({ token: true })
      .extend({ sshFingerprint: z.string() }),
  },
  diagnostics: {
    input: z.null(),
    output: z.object({
      checks: z.array(checkSchema),
      intents: z.array(publicIntent),
      hostNetworkNotice: z.string(),
    }),
  },
  catalog: {
    input: z.null(),
    output: z.object({
      hosts: z.array(choice),
      kernels: z.array(choice),
      images: z.array(choice),
    }),
  },
  inspect: {
    input: z.object({ key: z.string().max(256) }),
    output: z.object({
      resource: publicIntent,
      vm: z
        .object({ id: z.string(), name: z.string(), status: z.string() })
        .nullable(),
    }),
  },
});
export function createDummiePlugin(injectedExecutor?: typeof sshExecutor) {
  return async function plugin(bb: BbPluginApi) {
    const lifetime = new AbortController();
    bb.onDispose(() => lifetime.abort());
    const routing = createHostRouting(bb, lifetime.signal);
    const executorFactory = injectedExecutor ?? routing.executor;
    bb.agents.configure(() => ({ tools: [], skills: ["dummie"] }));
    const settings = bb.settings.define({
      executionHostId: {
        type: "string",
        label: "Local Dummie execution machine (blank: BB server)",
        default: "",
      },
      remoteExecutionHostId: {
        type: "string",
        label: "Default remote execution machine (choose in Dummie Remotes)",
        default: "",
      },
      connection: {
        type: "string",
        label: "Selected remote ID",
        default: "remote",
      },
      remoteProfiles: {
        type: "string",
        label: "Saved remote connections (managed in Dummie Settings)",
        secret: true,
        default: "[]",
      },
      remoteLabel: { type: "string", label: "Remote name", default: "" },
      remoteControlUrl: {
        type: "string",
        label: "Remote control origin (HTTPS)",
        default: "",
      },
      remoteToken: {
        type: "string",
        label: "Remote Dummie personal access token",
        secret: true,
      },
      remoteHost: {
        type: "string",
        label: "Remote default host ID",
        default: "",
      },
      remoteKernel: {
        type: "string",
        label: "Remote default kernel ID",
        default: "",
      },
      remoteImage: {
        type: "string",
        label: "Remote default OS image ID",
        default: "",
      },
      remoteSshHost: {
        type: "string",
        label: "Remote SSH proxy host",
        default: "",
      },
      remoteSshPort: {
        type: "number",
        label: "Remote SSH proxy port",
        default: 22,
        experimental_schema: z.number().int().min(1).max(65535),
      },
      remoteSshFingerprint: {
        type: "string",
        label: "Remote verified SSH proxy fingerprint (SHA256:...)",
        default: "",
      },
      remoteIdentityFile: {
        type: "string",
        label: "Remote SSH identity file (blank uses agent)",
        default: "",
      },
      remoteCpus: {
        type: "number",
        label: "Remote guest CPUs",
        default: 1,
        experimental_schema: z.number().int().min(1).max(8),
      },
      remoteMemory: {
        type: "number",
        label: "Remote guest memory MiB",
        default: 1024,
        experimental_schema: z.number().int().min(1024).max(16384),
      },
      remoteDisk: {
        type: "string",
        label: "Remote persistent disk size",
        default: "4G",
        experimental_schema: z.string().regex(/^[1-9][0-9]*[MG]$/),
      },
      remoteTargets: {
        type: "string",
        label: "Remote new-VM egress allowlist JSON",
        default: "[]",
        experimental_multiline: true,
        experimental_schema: z.string().refine((v) => {
          try {
            targetsSchema.parse(JSON.parse(v));
            return true;
          } catch {
            return false;
          }
        }, "Expected at most 32 Dummie egress targets."),
      },
      hostNetworkNotice: {
        type: "string",
        label: "Local host networking notice",
        default: "",
        experimental_multiline: true,
      },
      controlUrl: {
        type: "string",
        label: "Local control origin",
        default: "http://127.0.0.1:1323",
      },
      token: {
        type: "string",
        label: "Dummie personal access token",
        secret: true,
      },
      host: { type: "string", label: "Default Dummie host ID", default: "" },
      kernel: { type: "string", label: "Default kernel ID", default: "" },
      image: {
        type: "string",
        label: "Default OS image ID (Node 22+)",
        default: "",
      },
      sshHost: {
        type: "string",
        label: "SSH proxy host",
        default: "127.0.0.1",
      },
      sshPort: {
        type: "number",
        label: "SSH proxy port",
        default: 2224,
        experimental_schema: z.number().int().min(1).max(65535),
      },
      sshFingerprint: {
        type: "string",
        label: "Verified proxy fingerprint (SHA256:...)",
        default: "",
      },
      identityFile: {
        type: "string",
        label: "SSH private key path on BB server (blank uses agent)",
        default: "",
      },
      cpus: {
        type: "number",
        label: "Guest CPUs",
        default: 2,
        experimental_schema: z.number().int().min(1).max(8),
      },
      memory: {
        type: "number",
        label: "Guest memory MiB",
        default: 2048,
        experimental_schema: z.number().int().min(1024).max(16384),
      },
      disk: {
        type: "string",
        label: "Persistent disk size",
        default: "12G",
        experimental_schema: z.string().regex(/^\d+[MG]$/),
      },
      targets: {
        type: "string",
        label: "Egress allowlist JSON (BB, npm, Git and agent endpoints)",
        experimental_multiline: true,
        default: "[]",
        experimental_schema: z.string().refine((v) => {
          try {
            targetsSchema.parse(JSON.parse(v));
            return true;
          } catch {
            return false;
          }
        }, "Expected at most 32 Dummie egress targets."),
      },
    });
    const owner = (await bb.storage.kv.get<string>("owner")) ?? newOwner();
    await bb.storage.kv.set("owner", owner);
    const recipes = new Recipes(bb.storage.kv);
    const recipeRunner = new RecipeRunner(bb.storage.kv);
    const recipeJob = z.object({
      resource: resourceSchema,
      recipe: recipeSchema,
      state: z.enum(["pending", "running", "complete", "failed", "uncertain"]),
      createdAt: z.number(),
    });
    async function setupStatus(id: string) {
      const { api, life } = await connection(AbortSignal.timeout(15000));
      const vm = await api.get(id, AbortSignal.timeout(15000));
      if (!vm || vm.created_by !== life.account)
        throw Error("VM does not belong to the selected account.");
      const scope = setupScope(api.origin, life.account, id);
      const run = await recipeRunner.status(scope);
      const job = await bb.storage.kv.get("recipe:job:" + scope);
      return {
        api,
        life,
        vm,
        scope,
        run,
        job: job ? recipeJob.parse(job) : null,
      };
    }
    const store = {
      get: async (key: string) => {
        const v = await bb.storage.kv.get("intent:" + key);
        return v ? resourceSchema.parse(v) : null;
      },
      set: async (key: string, r: Resource) =>
        bb.storage.kv.set("intent:" + key, r),
    };
    const active = new Map<string, Promise<unknown>>();
    async function locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
      if (active.has(key))
        throw Error(
          "A lifecycle operation is already running for this allocation. Retry after it completes.",
        );
      const p = fn();
      active.set(key, p);
      try {
        return await p;
      } finally {
        active.delete(key);
      }
    }
    async function config(selected?: string, origin?: string) {
      const all = await settings.get();
      const profiles = remoteList.parse(JSON.parse(all.remoteProfiles));
      let profile = selected ?? all.connection;
      if (origin) {
        // Lifecycle follows the machine's original remote, independently of the picker.
        const pinned = profiles.find((p) => p.controlUrl === origin);
        if (pinned) profile = pinned.id;
        else if (endpoint(all.controlUrl) === origin) profile = "local";
        else if (
          all.remoteControlUrl &&
          endpoint(all.remoteControlUrl) === origin
        )
          profile = "remote";
        else
          throw Error(
            "Restore this machine's original remote before lifecycle actions.",
          );
      }
      const saved = profiles.find((p) => p.id === profile);
      if (!["local", "remote"].includes(profile) && !saved)
        throw Error(
          "This remote is no longer configured. Choose a remote in Dummie Settings.",
        );
      const cfg = saved
        ? { ...all, ...saved, hostNetworkNotice: "" }
        : profile === "remote"
          ? {
              ...all,
              executionHostId: all.remoteExecutionHostId,
              controlUrl: all.remoteControlUrl,
              token: all.remoteToken,
              host: all.remoteHost,
              kernel: all.remoteKernel,
              image: all.remoteImage,
              sshHost: all.remoteSshHost,
              sshPort: all.remoteSshPort,
              sshFingerprint: all.remoteSshFingerprint,
              identityFile: all.remoteIdentityFile,
              cpus: all.remoteCpus,
              memory: all.remoteMemory,
              disk: all.remoteDisk,
              targets: all.remoteTargets,
              hostNetworkNotice: "",
            }
          : all;
      return { ...cfg, connection: profile };
    }
    async function connection(
      signal: AbortSignal,
      selected?: string,
      resource?: Resource,
    ) {
      let cfg = await config(selected, resource?.endpoint);
      if (resource?.transport.executionHostId !== undefined)
        cfg = { ...cfg, executionHostId: resource.transport.executionHostId };
      if (!cfg.token)
        throw Error(
          "Add a remote and personal access token in Dummie Settings.",
        );
      if (!cfg.controlUrl)
        throw Error("Add a remote HTTPS address in Dummie Settings.");
      const origin = endpoint(cfg.controlUrl);
      const api = routing.api(origin, cfg.token, cfg.executionHostId);
      const account = await api.account(signal);
      return { cfg, api, life: new Lifecycle(api, store, owner, account) };
    }
    const intents = async () => {
      const rows = await bb.storage.kv.list("intent:");
      return (
        await Promise.all(rows.slice(-100).map((key) => bb.storage.kv.get(key)))
      ).map((value) => resourceSchema.parse(value));
    };
    async function diagnostics() {
      const checks: Array<z.infer<typeof checkSchema>> = [];
      const cfg = await config();
      checks.push({
        name: "Credentials",
        ok: !!cfg.token,
        detail: cfg.token
          ? "Secret setting present."
          : "Set a personal access token in BB plugin settings.",
      });
      try {
        const api = routing.api(
          endpoint(cfg.controlUrl),
          cfg.token ?? "",
          cfg.executionHostId,
        );
        await api.request("/health", AbortSignal.timeout(5000));
        checks.push({
          name: "Control API",
          ok: true,
          detail: "Health endpoint reachable.",
        });
        if (cfg.token) {
          const account = await api.account(AbortSignal.timeout(5000));
          checks.push({
            name: "Account",
            ok: true,
            detail: "Authenticated account verified.",
          });
          const hosts = await api.choices("hosts", AbortSignal.timeout(5000));
          checks.push({
            name: "Dummie hosts",
            ok: hosts.length > 0,
            detail: hosts.length
              ? `${hosts.length} connected host(s).`
              : "No connected Dummie hosts. Check the selected Dummie service.",
          });
          const quota = z
            .object({
              vcpu_limit: z.number(),
              vcpu_used: z.number(),
              memory_limit_mib: z.number(),
              memory_used_mib: z.number(),
              disk_limit_mib: z.number(),
              disk_used_mib: z.number(),
            })
            .parse(await api.request("/vms/quota", AbortSignal.timeout(5000)));
          const suffix = cfg.disk.slice(-1);
          const requestedDisk =
            Number(cfg.disk.slice(0, -1)) * (suffix === "G" ? 1024 : 1);
          checks.push({
            name: "New-guest quota",
            ok:
              quota.vcpu_used + cfg.cpus <= quota.vcpu_limit &&
              quota.memory_used_mib + cfg.memory <= quota.memory_limit_mib &&
              quota.disk_used_mib + requestedDisk <= quota.disk_limit_mib,
            detail: `Used/limit: ${quota.vcpu_used}/${quota.vcpu_limit} vCPU, ${quota.memory_used_mib}/${quota.memory_limit_mib} MiB RAM, ${quota.disk_used_mib}/${quota.disk_limit_mib} MiB disk. This check is for a new guest; existing guest resume needs no new allocation.`,
          });
        }
      } catch (e) {
        checks.push({
          name: "Control API / account",
          ok: false,
          detail: message(e),
        });
      }
      checks.push(
        {
          name: "Machine defaults",
          ok: !!(cfg.host && cfg.kernel && cfg.image),
          detail: "Choose host, kernel and OS image IDs using the catalog.",
        },
        {
          name: "SSH identity",
          ok: !!cfg.sshFingerprint,
          detail: cfg.sshFingerprint
            ? "Proxy fingerprint configured. Readiness verifies the presented key."
            : "Read the trusted host dpipe public key and configure its SHA256 fingerprint.",
        },
        {
          name: "Egress",
          ok: targetsSchema.parse(JSON.parse(cfg.targets)).length > 0,
          detail:
            "Configure BB, npm, Git and agent destinations. Verify guest forwarding and policy enforcement separately.",
        },
      );
      return {
        checks,
        intents: (await intents())
          .filter((r) => r.endpoint === endpoint(cfg.controlUrl))
          .map(safeIntent),
        hostNetworkNotice: cfg.hostNetworkNotice,
      };
    }
    async function catalog() {
      const { api } = await connection(AbortSignal.timeout(20000));
      const [hosts, kernels, images] = await Promise.all([
        api.choices("hosts", AbortSignal.timeout(15000)),
        api.choices("kernels", AbortSignal.timeout(15000)),
        api.choices("osimages", AbortSignal.timeout(15000)),
      ]);
      return { hosts, kernels, images };
    }
    const manager = new Manager({
      bb,
      owner,
      signal: lifetime.signal,
      connect: connection,
      locked,
      getRecipe: (id, revision) => recipes.get(id, revision),
      setupBusy: async (origin, account, id) => {
        const job = await bb.storage.kv.get(
          "recipe:job:" + setupScope(origin, account, id),
        );
        return (
          !!job && ["pending", "running"].includes(recipeJob.parse(job).state)
        );
      },
      pinRecipe: async (key, recipe) => {
        await bb.storage.kv.set("recipe:launch:" + key, recipe);
      },
      queueRecipe: async (vm, recipe, cfg, origin, account) => {
        const scope = setupScope(origin, account, vm.id);
        if (await bb.storage.kv.get("recipe:job:" + scope)) return;
        const configForVm = await config(cfg.connection);
        if (endpoint(configForVm.controlUrl) !== origin)
          throw Error("Connection changed before bootstrap was queued.");
        await bb.storage.kv.set("recipe:job:" + scope, {
          resource: {
            version: 1,
            key: "plain-recipe:" + scope,
            owner,
            endpoint: origin,
            account,
            name: vm.name,
            client: vm.client_id,
            vmId: vm.id,
            phase: "allocated",
            adopted: true,
            transport: transport(configForVm),
          },
          recipe,
          state: "pending",
          createdAt: Date.now(),
        });
      },
      resources: async () => {
        const keys = await bb.storage.kv.list("intent:");
        if (keys.length > 10000)
          throw Error("Too many allocation records for safe management.");
        return Promise.all(
          keys.map(async (key) =>
            resourceSchema.parse(await bb.storage.kv.get(key)),
          ),
        );
      },
      saveDefaults: async (p, selected) => {
        const cfg = await config(selected);
        if (!["local", "remote"].includes(cfg.connection)) {
          await locked("connections", async () => {
            const all = await settings.get();
            const profiles = remoteList.parse(JSON.parse(all.remoteProfiles));
            const index = profiles.findIndex((r) => r.id === cfg.connection);
            if (index < 0) throw Error("Remote no longer configured.");
            profiles[index] = {
              ...profiles[index]!,
              host: p.host,
              kernel: p.kernel,
              image: p.image,
              cpus: p.cpus,
              memory: p.memoryMiB,
              disk: p.disk,
              targets: JSON.stringify(p.targets.map(apiRule)),
            };
            await settings.experimental_set({
              remoteProfiles: JSON.stringify(profiles),
            });
          });
          return;
        }
        await settings.experimental_set(
          cfg.connection === "remote"
            ? {
                remoteHost: p.host,
                remoteKernel: p.kernel,
                remoteImage: p.image,
                remoteCpus: p.cpus,
                remoteMemory: p.memoryMiB,
                remoteDisk: p.disk,
                remoteTargets: JSON.stringify(p.targets.map(apiRule)),
              }
            : {
                host: p.host,
                kernel: p.kernel,
                image: p.image,
                cpus: p.cpus,
                memory: p.memoryMiB,
                disk: p.disk,
                targets: JSON.stringify(p.targets.map(apiRule)),
              },
        );
      },
    });
    const network = new NetworkAccess(bb.storage.kv);
    async function networkScope(selector: NetworkSelector) {
      const signal = AbortSignal.timeout(20000);
      let resource: Resource | undefined;
      let id: string | undefined;
      if ("threadId" in selector) {
        const thread = await bb.sdk.threads.get({
          threadId: selector.threadId,
        });
        if (!thread.environmentId) return null;
        const environment = await bb.sdk.environments.get({
          environmentId: thread.environmentId,
        });
        const host = await bb.sdk.hosts.get({ hostId: environment.hostId });
        if (host.machineProviderId !== "dummie") return null;
        resource = resourceSchema.parse(
          await bb.experimental_machines.getResource(host.id),
        );
        id = resource.vmId;
      } else id = selector.vmId;
      if (!id) return null;
      const { api, life, cfg } = await connection(signal, undefined, resource);
      const vm = resource
        ? await life.find(resource, signal)
        : await api.get(id, signal);
      if (!vm || vm.created_by !== life.account)
        throw Error("VM does not belong to this account.");
      const own = await manager.ownership(
        { api, account: life.account, cfg, signal },
        vm,
      );
      return {
        api,
        account: life.account,
        vm,
        signal,
        canManage:
          own.kind !== "protected" &&
          ["running", "stopped"].includes(vm.status) &&
          (!own.host || own.host.lifecycle.phase === "active"),
      };
    }
    bb.rpc.register(rpcContract, {
      suggest_name: async ({ key }) => {
        const { api, life } = await connection(AbortSignal.timeout(15000));
        return { name: friendlyName(api.origin + life.account, key) };
      },
      recipes_list: () => recipes.list(),
      recipes_save: (input) => locked("recipes", () => recipes.save(input)),
      recipes_delete: (input) =>
        locked("recipes", () => recipes.remove(input.id, input.revision)),
      setup_status: async (input) => {
        const s = await setupStatus(input.id);
        if (s.vm.name !== input.expectedName) throw Error("VM name changed.");
        return s.run
          ? setupRunSchema.parse(s.run)
          : s.job
            ? {
                recipeName: s.job.recipe.name,
                revision: s.job.recipe.revision,
                state: s.job.state,
                message: "Bootstrap queued. Waiting for guest readiness.",
                log: "",
              }
            : null;
      },
      setup_retry: async (input) =>
        locked("recipe-retry:" + input.id, async () => {
          const s = await setupStatus(input.id);
          if (
            s.vm.name !== input.expectedName ||
            input.confirmation !== s.vm.name
          )
            throw Error("Confirm the exact VM name before retrying bootstrap.");
          if (!s.job || !["failed", "uncertain"].includes(s.job.state))
            throw Error(
              "Use BB provisioning recovery for a managed VM, or wait for the running recipe.",
            );
          const { cfg } = await connection(AbortSignal.timeout(15000));
          const own = await manager.ownership(
            {
              api: s.api,
              account: s.life.account,
              cfg,
              signal: lifetime.signal,
            },
            s.vm,
          );
          if (own.kind !== "plain")
            throw Error("Tracked VMs must use BB provisioning recovery.");
          await bb.storage.kv.set("recipe:retry:" + s.scope, true);
          await bb.storage.kv.set("recipe:job:" + s.scope, {
            ...s.job,
            state: "pending",
            createdAt: Date.now(),
          });
          return {
            message: "Bootstrap retry queued. Review its log on this VM page.",
          };
        }),
      connections: async () => {
        const all = await settings.get();
        const profiles = remoteList.parse(JSON.parse(all.remoteProfiles));
        return {
          active: all.connection,
          profiles: [
            ...(all.remoteToken
              ? [
                  {
                    id: "remote",
                    label:
                      all.remoteLabel || new URL(all.remoteControlUrl).hostname,
                    origin: endpoint(all.remoteControlUrl),
                    credentialsConfigured: !!all.remoteToken,
                  },
                ]
              : []),
            ...profiles.map((p) => ({
              id: p.id,
              label: p.label,
              origin: p.controlUrl,
              credentialsConfigured: !!p.token,
            })),
          ],
        };
      },
      execution_machines: async () =>
        (await bb.sdk.hosts.list()).map((h) => ({
          id: h.id,
          name: h.name,
          status: h.status,
        })),
      connection_details: async ({ id }) => {
        const cfg = await config(id);
        if (id === "local") throw Error("Local installation has been retired.");
        return {
          id,
          label:
            id === "remote"
              ? cfg.remoteLabel || new URL(cfg.controlUrl).hostname
              : remoteList
                  .parse(JSON.parse(cfg.remoteProfiles))
                  .find((p) => p.id === id)!.label,
          controlUrl: cfg.controlUrl,
          executionHostId: cfg.executionHostId,
          sshHost: cfg.sshHost,
          sshPort: cfg.sshPort,
          sshFingerprint: cfg.sshFingerprint,
          identityFile: cfg.identityFile,
          host: cfg.host,
          kernel: cfg.kernel,
          image: cfg.image,
          cpus: cfg.cpus,
          memory: cfg.memory,
          disk: cfg.disk,
          targets: cfg.targets,
        };
      },
      save_connection: (input) =>
        locked("connections", async () => {
          const all = await settings.get();
          const profiles = remoteList.parse(JSON.parse(all.remoteProfiles));
          const id = input.id ?? randomUUID();
          const existing = input.id ? await config(input.id) : null;
          if (id === "local")
            throw Error("Connect to a remote Dummie instead.");
          const origin = endpoint(input.controlUrl);
          if (!origin.startsWith("https://"))
            throw Error("Remote Dummie requires HTTPS.");
          if (existing && endpoint(existing.controlUrl) !== origin)
            throw Error(
              "Add a new remote to use a different address. Existing machines keep their original remote.",
            );
          if (
            profiles.some((p) => p.id !== id && p.controlUrl === origin) ||
            (id !== "remote" &&
              !!all.remoteToken &&
              endpoint(all.remoteControlUrl) === origin)
          )
            throw Error(
              "This remote is already saved. Edit its connection instead.",
            );
          const value = remoteSchema.parse({
            ...existing,
            ...input,
            id,
            controlUrl: origin,
            token: input.token || existing?.token,
          });
          if (
            value.executionHostId &&
            !(await bb.sdk.hosts.list()).some(
              (h) => h.id === value.executionHostId,
            )
          )
            throw Error(
              "Choose an enrolled BB execution machine for this remote.",
            );
          if (id === "remote") {
            await settings.experimental_set({
              remoteLabel: value.label,
              remoteExecutionHostId: value.executionHostId,
              remoteToken: value.token,
              remoteSshHost: value.sshHost,
              remoteSshPort: value.sshPort,
              remoteSshFingerprint: value.sshFingerprint,
              remoteIdentityFile: value.identityFile,
            });
          } else {
            const index = profiles.findIndex((p) => p.id === id);
            if (index < 0) profiles.push(value);
            else profiles[index] = value;
            await settings.experimental_set({
              remoteProfiles: JSON.stringify(remoteList.parse(profiles)),
            });
          }
          return { id };
        }),
      select_connection: async ({ connection: selected }) => {
        if (selected === "local")
          throw Error("Connect to a remote Dummie instead.");
        endpoint((await config(selected)).controlUrl);
        await settings.experimental_set({ connection: selected });
        return { saved: true as const };
      },
      network_status: async (selector) => {
        const scope = await networkScope(selector);
        return scope ? network.status(scope) : null;
      },
      network_allow: async (input) => {
        const scope = await networkScope(input.selector);
        if (!scope) throw Error("This thread does not use a Dummie VM.");
        return locked("manager-vm:" + scope.vm.id, () =>
          network.allow(scope, input),
        );
      },
      network_revoke: async (input) => {
        const scope = await networkScope(input.selector);
        if (!scope) throw Error("This thread does not use a Dummie VM.");
        return locked("manager-vm:" + scope.vm.id, () =>
          network.revoke(scope, input),
        );
      },
      manager_enroll: (input) => manager.enroll(input),
      manager_inventory: (input) => manager.inventory(input),
      integrations_catalog: () => manager.integrationCatalog(),
      integrations_status: ({ id }) => manager.integrations(id),
      integrations_save: (input) => manager.saveIntegration(input),
      integrations_detach: (input) => manager.detachIntegration(input),
      manager_detail: ({ id }) => manager.detail(id),
      manager_setup: () => manager.setup(),
      manager_defaults: (input) => manager.saveDefaults(input),
      manager_create: (input) => manager.create(input),
      manager_request: ({ key }) => manager.request(key),
      manager_action: (input) => manager.action(input),
      manager_edit: (input) => manager.edit(input),
      manager_target_save: (input) => manager.saveTarget(input),
      manager_target_remove: (input) => manager.removeTarget(input),
      diagnostics,
      catalog,
      inspect: async ({ key }) => {
        const resource = await store.get(key);
        if (!resource) throw Error("Unknown allocation key.");
        const { life } = await connection(
          AbortSignal.timeout(20000),
          undefined,
          resource,
        );
        const vm = await life.find(resource, AbortSignal.timeout(15000));
        return {
          resource: safeIntent(resource),
          vm: vm ? { id: vm.id, name: vm.name, status: vm.status } : null,
        };
      },
    });
    const transport = (cfg: Awaited<ReturnType<typeof settings.get>>) => ({
      executionHostId: cfg.executionHostId,
      host: cfg.sshHost,
      port: cfg.sshPort,
      fingerprint: cfg.sshFingerprint,
      identityFile: cfg.identityFile,
    });
    async function ready(
      life: Lifecycle,
      r: Resource,
      signal: AbortSignal,
      recipe?: Recipe,
      retryBootstrap = false,
      report?: (step: string) => void,
    ) {
      await life.start(r, signal);
      if (recipe) {
        report?.("Connecting recipe repository integrations");
        await attachRecipeIntegrations(life.api, recipe, r.vmId!, signal);
      }
      const cfg = await config(undefined, r.endpoint);
      const executor = executorFactory(
        {
          ...r.transport,
          executionHostId: r.transport.executionHostId ?? cfg.executionHostId,
        },
        r.name,
      );
      const end = Date.now() + 180000;
      while (true) {
        signal.throwIfAborted();
        let rejectedName = false;
        try {
          let probeOutput = "";
          const probe = await executor.exec({
            command: ["true"],
            stdin: "",
            signal,
            timeoutMs: 10000,
            onOutput: (text) => {
              probeOutput = (probeOutput + text).slice(-2000);
            },
          });
          if (probe.exitCode === 0) break;
          rejectedName = probeOutput.includes("No VM named");
        } catch {
          signal.throwIfAborted();
        }
        if (rejectedName)
          throw Error(
            "The SSH proxy rejected this VM name. Use the SSH host matching the VM's API-reported domain; the VM was retained.",
          );
        if (Date.now() > end)
          throw Error(
            "SSH readiness timed out. VM retained; check tunnel, fingerprint and account key.",
          );
        await pause(signal, 2000);
      }
      if (recipe?.bootstrapScript.trim()) {
        report?.("Running " + recipe.name + " bootstrap recipe");
        await recipeRunner.run(
          setupScope(r.endpoint, r.account, r.vmId!),
          recipe,
          executor,
          signal,
          retryBootstrap,
        );
      }
      report?.("Checking BB runtime prerequisites");
      const result = await executor.exec({
        command: prerequisites,
        stdin: "",
        signal,
        timeoutMs: 30000,
        onOutput: () => {},
      });
      if (result.exitCode !== 0)
        throw Error(
          "Guest lacks BB prerequisites: Node 22+, npm, curl, Git, make, g++, Python 3 and setsid. VM retained.",
        );
      return executor;
    }
    bb.experimental_environments.register({
      id: "dummie",
      displayName: "Dummie VM",
      description: "Clone a project with a Git remote onto a new Dummie VM.",
      icon: "Server",
      machineProviderId: "dummie",
      environmentProviderId: "project-checkout",
    });
    bb.experimental_environments.register({
      id: "dummie-scratch",
      displayName: "Dummie scratch VM",
      description:
        "Start a new Dummie VM with an empty personal workspace. No Git remote required.",
      icon: "Server",
      machineProviderId: "dummie",
      environmentProviderId: "personal-workspace",
    });
    bb.experimental_machines.register({
      id: "dummie",
      displayName: "Dummie",
      description: "Persistent Dummie VM with verified SSH and BB enrollment.",
      icon: "Server",
      ephemeral: false,
      inputs: choicesSchema,
      availability: async () => {
        const cfg = await config();
        return cfg.token && cfg.sshFingerprint
          ? { status: "available" }
          : {
              status: "setup-required",
              message:
                "Open Dummie diagnostics and configure token, host, kernel, image and SSH fingerprint.",
            };
      },
      create: async (ctx) =>
        locked(ctx.key, async () => {
          ctx = {
            ...ctx,
            signal: AbortSignal.any([ctx.signal, lifetime.signal]),
          };
          try {
            const input = ctx.inputs ?? {};
            const previous = await store.get(ctx.key);
            const recovery = input.recover
              ? await store.get(input.recover)
              : null;
            const { cfg, api, life } = await connection(
              ctx.signal,
              input.connection,
              previous ?? recovery ?? undefined,
            );
            const recipe = await recipes.pin(
              ctx.key,
              input.recipeId,
              input.recipeRevision,
              input.recover,
            );
            if (recipe.mode !== "bb")
              throw Error(
                "Select a BB-enrolled recipe for machine provisioning. Create plain recipes from the Dummie manager.",
              );
            await checkRecipeIntegrations(api, recipe, ctx.signal);
            if (input.existingVmId) {
              if (!input.expectedName || input.recover)
                throw Error(
                  "Existing VM enrollment requires its exact name and cannot combine with recovery.",
                );
              return await locked(
                "adopt:" + api.origin + ":" + input.existingVmId,
                async () => {
                  const vm = await api.get(input.existingVmId!, ctx.signal);
                  if (!vm)
                    throw Error(
                      "Existing VM is missing; no replacement will be allocated.",
                    );
                  const own = await manager.ownership(
                    { api, account: life.account, cfg, signal: ctx.signal },
                    vm,
                  );
                  if (own.kind !== "plain" && own.resource?.key !== ctx.key)
                    throw Error(
                      "This VM is already tracked. Use its BB machine or recovery flow.",
                    );
                  const op = await manager.operation(
                    { api, account: life.account, cfg, signal: ctx.signal },
                    vm.id,
                  );
                  if (op && ["pending", "uncertain"].includes(op.state))
                    throw Error(
                      "Finish or reconcile the VM's pending operation before enrollment.",
                    );
                  const r = await life.adopt(
                    ctx.key,
                    vm.id,
                    input.expectedName!,
                    transport(cfg),
                    ctx.signal,
                  );
                  await ctx.checkpoint(r);
                  ctx.report.step(
                    "Checking existing VM and BB prerequisites; disk remains owned by Dummie",
                  );
                  const executor = await ready(
                    life,
                    r,
                    ctx.signal,
                    recipe,
                    input.retryBootstrap,
                    (step) => ctx.report.step(step),
                  );
                  await bb.experimental_machines.bootstrap({
                    key: ctx.key,
                    executor,
                    report: ctx.report,
                    signal: ctx.signal,
                  });
                  const enrolled = { ...r, enrolled: true };
                  await store.set(r.key, enrolled);
                  await ctx.checkpoint(enrolled);
                  return {
                    status: "created" as const,
                    name: r.name,
                    resource: enrolled,
                  };
                },
              );
            }
            const host = input.host ?? recipe.profile?.host ?? cfg.host,
              kernel = input.kernel ?? recipe.profile?.kernel ?? cfg.kernel,
              image = input.image ?? recipe.profile?.image ?? cfg.image;
            if (!recovery && !previous) {
              z.string().uuid().parse(host);
              z.string().uuid().parse(kernel);
              z.string().uuid().parse(image);
            }
            const body = {
              client_id: host,
              kernel_id: kernel,
              osimage_id: image,
              cpus: input.cpus ?? recipe.profile?.cpus ?? cfg.cpus,
              memory_mib:
                input.memoryMiB ?? recipe.profile?.memoryMiB ?? cfg.memory,
              disk_size: input.disk ?? recipe.profile?.disk ?? cfg.disk,
              targets: targetsSchema.parse(
                [
                  ...(input.targets ??
                    recipe.profile?.targets.map(apiRule) ??
                    targetsSchema.parse(JSON.parse(cfg.targets))),
                  ...bootstrapTargets(recipe),
                ].filter(
                  (target, index, rows) =>
                    rows.findIndex(
                      (r) =>
                        r.destination === target.destination &&
                        r.ports === target.ports,
                    ) === index,
                ),
              ),
            };
            const recoveryKey =
              input.recover ?? (await store.get(ctx.key))?.recoveredFrom;
            const r0 = recoveryKey
              ? await locked(recoveryKey, async () => {
                  if (recoveryKey === ctx.key)
                    throw Error("Recovery requires a new launch key.");
                  const source = await store.get(recoveryKey);
                  if (
                    !source ||
                    !source.vmId ||
                    source.enrolled ||
                    source.phase !== "allocated"
                  )
                    throw Error(
                      "Only an owned, allocated, unenrolled guest can be recovered.",
                    );
                  await life.verify(source);
                  if (source.transferredTo && source.transferredTo !== ctx.key)
                    throw Error(
                      "This guest has already been transferred to another launch.",
                    );
                  if (!source.transferredTo) {
                    const hosts = await bb.sdk.hosts.list();
                    let failed = false;
                    for (const previous of hosts) {
                      if (previous.machineProviderId !== "dummie") continue;
                      const record = await bb.experimental_machines.getResource(
                        previous.id,
                      );
                      if (
                        !record ||
                        resourceSchema.safeParse(record).data?.key !==
                          recoveryKey
                      )
                        continue;
                      if (
                        previous.status !== "disconnected" ||
                        previous.lifecycle.phase !== "removing" ||
                        previous.lifecycle.teardown?.status !== "failed"
                      )
                        throw Error(
                          "The original launch is still live; recovery refused.",
                        );
                      failed = true;
                    }
                    if (!failed)
                      throw Error(
                        "The original launch must be in failed cleanup before recovery.",
                      );
                  }
                  const vm = await life.find(source, ctx.signal);
                  if (!vm) throw Error("Recovery guest is missing.");
                  const { transferredTo, ...owned } = source;
                  const recovered = (await store.get(ctx.key)) ?? {
                    ...owned,
                    key: ctx.key,
                    recoveredFrom: recoveryKey,
                    ...(input.refreshTransport
                      ? { transport: transport(cfg) }
                      : {}),
                  };
                  // Keep both records. A crash before the source claim leaves an
                  // unenrolled target; its replay finishes the same transfer.
                  await store.set(ctx.key, recovered);
                  await store.set(recoveryKey, {
                    ...source,
                    transferredTo: ctx.key,
                  });
                  return recovered;
                })
              : await life.intent(
                  ctx.key,
                  host,
                  transport(cfg),
                  body,
                  input.name,
                );
            ctx.report.step("Reconciling persistent Dummie allocation");
            const r = await life.allocate(r0, body, ctx.signal);
            await ctx.checkpoint(r);
            ctx.report.step("Waiting for guest SSH and BB prerequisites");
            const executor = await ready(
              life,
              r,
              ctx.signal,
              recipe,
              input.retryBootstrap,
              (step) => ctx.report.step(step),
            );
            ctx.report.step("Enrolling BB daemon");
            await bb.experimental_machines.bootstrap({
              key: ctx.key,
              executor,
              report: ctx.report,
              signal: ctx.signal,
            });
            const enrolled = { ...r, enrolled: true };
            await store.set(r.key, enrolled);
            await ctx.checkpoint(enrolled);
            return {
              status: "created" as const,
              name: r.name,
              resource: enrolled,
            };
          } catch (e) {
            ctx.signal.throwIfAborted();
            return { status: "failed" as const, message: message(e) };
          }
        }),
      suspend: async (ctx) => {
        ctx = {
          ...ctx,
          signal: AbortSignal.any([ctx.signal, lifetime.signal]),
        };
        const r = resourceSchema.parse(ctx.resource);
        return locked(r.key, async () => {
          const { life } = await connection(ctx.signal, undefined, r);
          await ctx.checkpoint(r);
          ctx.report.step("Stopping VM and preserving disk");
          await life.stop(r, ctx.signal);
          return { resource: r };
        });
      },
      resume: async (ctx) => {
        ctx = {
          ...ctx,
          signal: AbortSignal.any([ctx.signal, lifetime.signal]),
        };
        const r = resourceSchema.parse(ctx.resource);
        return locked(r.key, async () => {
          const { life } = await connection(ctx.signal, undefined, r);
          await ctx.checkpoint(r);
          const executor = await ready(life, r, ctx.signal);
          await bb.experimental_machines.bootstrap({
            key: r.key,
            executor,
            report: ctx.report,
            signal: ctx.signal,
          });
          return { resource: r };
        });
      },
      remove: async (ctx) => {
        ctx = {
          ...ctx,
          signal: AbortSignal.any([ctx.signal, lifetime.signal]),
        };
        const r = resourceSchema.parse(ctx.resource);
        return locked(r.key, async () => {
          try {
            const saved = await store.get(r.key);
            if (
              saved?.transferredTo ||
              (saved?.phase === "removed" &&
                saved.owner === owner &&
                saved.endpoint === r.endpoint &&
                saved.account === r.account &&
                saved.name === r.name &&
                saved.vmId === r.vmId)
            )
              return { status: "removed" as const };
            const { life } = await connection(ctx.signal, undefined, r);
            if (
              !r.enrolled &&
              !(await bb.storage.kv.get<boolean>("remove-approved:" + r.key)) &&
              (await life.find(r, ctx.signal))
            )
              throw Error(
                "Unenrolled guest retained for review. Explicitly destroy it with bb dummie remove <BB-host-id> --yes.",
              );
            await life.remove(r, ctx.signal);
            return { status: "removed" as const };
          } catch (e) {
            ctx.signal.throwIfAborted();
            return { status: "failed" as const, message: message(e) };
          }
        });
      },
      reconcileCleanup: async (ctx) =>
        locked(ctx.key, async () => {
          ctx = {
            ...ctx,
            signal: AbortSignal.any([ctx.signal, lifetime.signal]),
          };
          try {
            const r = await store.get(ctx.key);
            if (
              !r ||
              r.transferredTo ||
              (r.phase === "removed" && r.owner === owner)
            )
              return { status: "removed" as const };
            const { life } = await connection(ctx.signal, undefined, r);
            if (
              !r.enrolled &&
              !(await bb.storage.kv.get<boolean>("remove-approved:" + r.key)) &&
              (await life.find(r, ctx.signal))
            )
              throw Error(
                "Unenrolled guest retained for review. Explicitly destroy it with bb dummie remove <BB-host-id> --yes.",
              );
            await life.remove(r, ctx.signal);
            return { status: "removed" as const };
          } catch (e) {
            ctx.signal.throwIfAborted();
            return { status: "failed" as const, message: message(e) };
          }
        }),
    });
    bb.background.service("recipe-bootstrap", {
      async start(signal) {
        while (!signal.aborted) {
          try {
            const keys = await bb.storage.kv.list("recipe:job:");
            if (keys.length > 10000)
              throw Error(
                "Recipe job limit exceeded; archive completed job history before queuing more.",
              );
            for (const key of keys) {
              signal.throwIfAborted();
              const job = recipeJob.parse(await bb.storage.kv.get(key));
              if (!["pending", "running"].includes(job.state)) continue;
              await locked(key, async () => {
                const scope = key.slice("recipe:job:".length);
                try {
                  const { api, life, cfg } = await connection(
                    signal,
                    undefined,
                    job.resource,
                  );
                  const vm = await life.find(job.resource, signal);
                  if (!vm)
                    throw Error(
                      "Bootstrap VM is missing. No replacement was allocated.",
                    );
                  const own = await manager.ownership(
                    { api, account: life.account, cfg, signal },
                    vm,
                  );
                  if (own.kind !== "plain")
                    throw Error(
                      "VM is now tracked by BB. Plain bootstrap paused.",
                    );
                  if (vm.status !== "running") {
                    if (
                      Date.now() - job.createdAt > 900000 ||
                      ["failed", "gone"].includes(vm.status)
                    )
                      throw Error("VM did not become ready for bootstrap.");
                    return;
                  }
                  await attachRecipeIntegrations(
                    api,
                    job.recipe,
                    vm.id,
                    signal,
                  );
                  const executor = executorFactory(
                    {
                      ...job.resource.transport,
                      executionHostId:
                        job.resource.transport.executionHostId ??
                        (await config(undefined, job.resource.endpoint))
                          .executionHostId,
                    },
                    job.resource.name,
                  );
                  await executor.exec({
                    command: ["true"],
                    stdin: "",
                    timeoutMs: 15000,
                    signal,
                    onOutput() {},
                  });
                  await bb.storage.kv.set(key, { ...job, state: "running" });
                  const retry = !!(await bb.storage.kv.get(
                    "recipe:retry:" + scope,
                  ));
                  await bb.storage.kv.delete("recipe:retry:" + scope);
                  await recipeRunner.run(
                    scope,
                    job.recipe,
                    executor,
                    signal,
                    retry,
                  );
                  await bb.storage.kv.set(key, { ...job, state: "complete" });
                } catch (e) {
                  if (signal.aborted) return;
                  const run = await recipeRunner.status(scope);
                  // A not-yet-ready SSH proxy can be retried before any script started.
                  if (!run && Date.now() - job.createdAt < 180000) return;
                  await bb.storage.kv.set(key, {
                    ...job,
                    state: run?.state === "uncertain" ? "uncertain" : "failed",
                  });
                  if (!run)
                    await bb.storage.kv.set("recipe:run:" + scope, {
                      recipe: job.recipe,
                      fingerprint: digest(job.recipe),
                      recipeName: job.recipe.name,
                      revision: job.recipe.revision,
                      state: "failed",
                      message: message(e),
                      log: "",
                    });
                }
              });
            }
          } catch (e) {
            if (!signal.aborted)
              bb.log.warn("Dummie recipe worker: " + message(e));
          }
          try {
            await pause(signal, 5000);
          } catch {
            return;
          }
        }
      },
    });
    // Reassert suspended state after reload or an external start, through core's
    // drain/reconciliation path. Never allocate or destroy from this sweep.
    bb.background.service("reconcile", {
      async start(signal) {
        while (!signal.aborted) {
          try {
            const cfg = await settings.get();
            if (
              cfg.token ||
              cfg.remoteToken ||
              remoteList.parse(JSON.parse(cfg.remoteProfiles)).length
            ) {
              const hosts = await bb.sdk.hosts.list();
              for (const host of hosts) {
                signal.throwIfAborted();
                if (
                  host.machineProviderId !== "dummie" ||
                  host.lifecycle.phase !== "suspended"
                )
                  continue;
                try {
                  const stored = await bb.experimental_machines.getResource(
                    host.id,
                  );
                  if (!stored) continue;
                  const r = resourceSchema.parse(stored);
                  const { life } = await connection(signal, undefined, r);
                  const vm = await life.find(r, signal);
                  if (vm?.status === "running")
                    await bb.sdk.hosts.experimental_reconcile({
                      hostId: host.id,
                    });
                } catch (e) {
                  signal.throwIfAborted();
                  bb.log.warn(
                    "Dummie reconciliation for " + host.id + ": " + message(e),
                  );
                }
              }
            }
          } catch (e) {
            if (signal.aborted) return;
            bb.log.warn("Dummie reconciliation: " + message(e));
          }
          try {
            await pause(signal, 60000);
          } catch {
            return;
          }
        }
      },
    });
    const commands = [
      "retire-local",
      "enroll",
      "diagnostics",
      "inventory",
      "setup",
      "catalog",
      "list",
      "inspect",
      "suspend",
      "resume",
      "remove",
      "reconcile",
    ];
    bb.cli.register({
      name: "dummie",
      summary: "Diagnose Dummie and manage BB-owned persistent machines",
      commands: commands.map((name) => ({
        name,
        summary:
          name === "remove"
            ? "Remove a BB machine; adopted disks are retained (requires --yes)"
            : name,
        usage: `bb dummie ${name}${name === "retire-local" ? " --yes" : name === "enroll" ? " <vm-id> <vm-name>" : ["inspect"].includes(name) ? " <allocation-key>" : ["suspend", "resume", "remove", "reconcile"].includes(name) ? " <bb-host-id>" : ""} [--json]`,
      })),
      async run(argv) {
        try {
          const args = argv.filter((a) => a !== "--json");
          const [cmd, id, flag] = args;
          let out: unknown;
          if (cmd === "retire-local" && id === "--yes" && args.length === 2) {
            const cfg = await settings.get();
            const origin = endpoint(cfg.controlUrl);
            if (
              !["localhost", "127.0.0.1", "[::1]"].includes(
                new URL(origin).hostname,
              )
            )
              throw Error(
                "Retirement is limited to an already removed loopback Dummie installation.",
              );
            const rows = (await intents()).filter((r) => r.endpoint === origin);
            if (rows.some((r) => r.owner !== owner))
              throw Error("Local allocation ownership mismatch.");
            for (const host of await bb.sdk.hosts.list()) {
              if (host.machineProviderId !== "dummie") continue;
              const raw = await bb.experimental_machines.getResource(host.id);
              if (!raw) continue;
              const r = resourceSchema.parse(raw);
              if (r.endpoint !== origin) continue;
              if (
                r.owner !== owner ||
                host.status !== "disconnected" ||
                !["active", "suspended", "removing"].includes(
                  host.lifecycle.phase,
                )
              )
                throw Error(
                  "Disconnect local machines and finish active operations before retiring the removed installation.",
                );
              if (!rows.some((row) => row.key === r.key)) rows.push(r);
            }
            // Explicit acknowledgement that the whole local installation was removed.
            // Keep tombstones so stale core cleanup never reallocates or contacts compute.
            for (const r of rows)
              await store.set(r.key, { ...r, phase: "removed" });
            await settings.experimental_set({
              connection: "remote",
              token: null,
              host: null,
              kernel: null,
              image: null,
              sshFingerprint: null,
              identityFile: null,
              targets: null,
              hostNetworkNotice: null,
              controlUrl: null,
              sshHost: null,
              sshPort: null,
              cpus: null,
              memory: null,
              disk: null,
            });
            out = {
              retired: rows.length,
              message:
                "Removed local installation acknowledged. Local settings cleared; remote settings preserved. Remove disconnected local BB machine records through core.",
            };
          } else if (cmd === "retire-local")
            throw Error(
              "Only after removing the entire local Dummie installation, use bb dummie retire-local --yes. This retires its BB allocation records without contacting compute.",
            );
          else if (cmd === "enroll" && id && flag && args.length === 3)
            out = await manager.enroll({ id, expectedName: flag });
          else if (cmd === "inventory" && args.length === 1)
            out = await manager.inventory({
              search: "",
              status: "all",
              offset: 0,
              limit: 20,
            });
          else if (cmd === "setup" && args.length === 1)
            out = await manager.setup();
          else if (cmd === "diagnostics" && args.length === 1)
            out = await diagnostics();
          else if (cmd === "catalog" && args.length === 1)
            out = await catalog();
          else if (cmd === "list" && args.length === 1) out = await intents();
          else if (cmd === "inspect" && id && args.length === 2) {
            const r = await store.get(id);
            if (!r) throw Error("Unknown allocation key.");
            const { life } = await connection(
              AbortSignal.timeout(20000),
              undefined,
              r,
            );
            out = {
              resource: r,
              vm: await life.find(r, AbortSignal.timeout(15000)),
            };
          } else if (
            id &&
            ["suspend", "resume", "remove", "reconcile"].includes(cmd!)
          ) {
            if (
              args.length !== (cmd === "remove" ? 3 : 2) ||
              (cmd === "remove" && flag !== "--yes")
            )
              throw Error(
                "Removal deletes the VM disk. Use bb dummie remove <bb-host-id> --yes.",
              );
            const h = await bb.sdk.hosts.get({ hostId: id });
            if (h.machineProviderId !== "dummie")
              throw Error("This BB machine is not owned by Dummie.");
            if (cmd === "remove") {
              const stored = await bb.experimental_machines.getResource(id);
              if (stored) {
                const r = resourceSchema.parse(stored);
                await bb.storage.kv.set("remove-approved:" + r.key, true);
              }
            }
            out =
              cmd === "suspend"
                ? await bb.sdk.hosts.experimental_suspend({ hostId: id })
                : cmd === "resume"
                  ? await bb.sdk.hosts.experimental_resume({ hostId: id })
                  : cmd === "reconcile"
                    ? await bb.sdk.hosts.experimental_reconcile({ hostId: id })
                    : await bb.sdk.hosts.delete({ hostId: id });
          } else
            return {
              exitCode:
                !args.length || ["--help", "help"].includes(cmd!) ? 0 : 1,
              stdout:
                "bb dummie retire-local --yes | diagnostics | inventory | setup | catalog | list | inspect <allocation-key> | enroll <vm-id> <vm-name> | suspend <bb-host-id> | resume <bb-host-id> | remove <bb-host-id> --yes | reconcile <bb-host-id>\nUse bb machine create --help to allocate a machine with provider dummie. Adopted VMs retain their disk on BB removal.",
            };
          const stdout = JSON.stringify(out, null, 2);
          if (stdout.length > 100000)
            throw Error("Output exceeded 100 KB. Narrow the query.");
          return { exitCode: 0, stdout };
        } catch (e) {
          return { exitCode: 1, stderr: message(e) };
        }
      },
    });
  };
}
export default createDummiePlugin();
function message(e: unknown) {
  return e instanceof Error
    ? e.message.slice(0, 700)
    : "Dummie operation failed.";
}
