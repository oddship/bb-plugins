import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { definePluginApp, useRpc, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type {
  PluginNavPanelProps,
  ExperimentalThreadContextSegmentProps,
  PluginMachineProviderInputsProps,
} from "@get-bb/plugin-sdk";
import type { rpcContract } from "./server.js";
import type { NetworkSelector } from "./network.js";
import type {
  Setup,
  Inventory,
  ManagedVm,
  Profile,
  Rule,
  Receipt,
  Detail,
  Recipe,
} from "./manager-contract.js";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { ConfirmDialog, ReviewDialog } from "./components/ui/dialog";
type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
const Context = createContext<{
  rpc: Rpc;
  setup: Setup | null;
  setupError: string;
  refreshSetup(): void;
  go(path: string): void;
} | null>(null);
function useManager() {
  return useContext(Context)!;
}
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
function useLoad<T>(
  load: () => Promise<T>,
  interval = 0,
  blocked?: RefObject<boolean>,
) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    let disposed = false,
      inFlight = false;
    const run = async () => {
      if (inFlight || blocked?.current) return;
      inFlight = true;
      setLoading(true);
      try {
        const result = await load();
        if (!disposed) {
          setData(result);
          setError("");
        }
      } catch (e) {
        if (!disposed) setError(message(e));
      } finally {
        inFlight = false;
        if (!disposed) setLoading(false);
      }
    };
    void run();
    const timer = interval
      ? setInterval(() => {
          if (!document.hidden) void run();
        }, interval)
      : null;
    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
    };
  }, [load, interval, version, blocked]);
  const clear = useCallback(() => {
    setData(null);
    setError("");
  }, []);
  return { data, error, loading, refresh, clear };
}
function useAction() {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const run = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    if (pending.current) return null;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const value = await fn();
      return value;
    } catch (e) {
      setError(message(e));
      return null;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return { pending, busy, error, notice, setNotice, run };
}
function Alert({ children }: { children: ReactNode }) {
  return children ? (
    <p
      role="alert"
      className="rounded-md border border-destructive/40 p-3 text-sm text-destructive break-words"
    >
      {children}
    </p>
  ) : null;
}
function Note({ children }: { children: ReactNode }) {
  return children ? (
    <p
      role="status"
      className="rounded-md border border-border bg-muted/30 p-3 text-sm break-words"
    >
      {children}
    </p>
  ) : null;
}
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="block min-w-0 space-y-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint && (
        <span className="block text-xs text-muted-foreground">{hint}</span>
      )}
    </label>
  );
}
function Select({
  value,
  onChange,
  label,
  children,
  disabled,
}: {
  value: string;
  onChange(v: string): void;
  label?: string;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm disabled:opacity-50"
    >
      {children}
    </select>
  );
}
function Size({ mib }: { mib: number }) {
  return (
    <>
      {mib
        ? mib >= 1024
          ? (mib / 1024).toLocaleString(undefined, {
              maximumFractionDigits: 1,
            }) + " GiB"
          : mib + " MiB"
        : "Not reported"}
    </>
  );
}
const friendlyState = (state: string) =>
  ({
    pending: "Starting",
    posting: "Creating",
    prepared: "Ready to create",
    confirmed: "Created",
    rejected: "Could not create",
    running: "Running",
    stopped: "Stopped",
    complete: "Setup complete",
    failed: "Needs attention",
    uncertain: "Setup interrupted",
    gone: "Removed",
  })[state] ?? state;
function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex max-w-full rounded-full border border-border px-2 py-0.5 text-xs break-all">
      {children}
    </span>
  );
}
function Quota({ setup }: { setup: Setup }) {
  const q = setup.quota;
  return (
    <section aria-label="Account quota" className="grid gap-2 sm:grid-cols-3">
      {[
        ["CPU", q.vcpu_used, q.vcpu_limit, "vCPU"],
        ["Memory", q.memory_used_mib, q.memory_limit_mib, "MiB"],
        ["Disk", q.disk_used_mib, q.disk_limit_mib, "MiB"],
      ].map(([title, used, limit, unit]) => (
        <div key={title} className="rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">{title} used / limit</p>
          <p className="mt-1 font-medium">
            {used} / {limit} {unit}
          </p>
        </div>
      ))}
    </section>
  );
}
const emptyRule = (): Rule => ({
  kind: "domain",
  destination: "",
  transport: "tcp",
  ports: "443",
  note: "",
  ttlSeconds: 0,
});
function RuleFields({
  value,
  onChange,
}: {
  value: Rule;
  onChange(r: Rule): void;
}) {
  const patch = (p: Partial<Rule>) => onChange({ ...value, ...p });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Destination type">
        <Select
          value={value.kind}
          onChange={(v) =>
            patch({
              kind: v as Rule["kind"],
              ports: v === "domain" ? "443" : "",
              transport: "tcp",
            })
          }
        >
          <option value="domain">Domain</option>
          <option value="ip">IP address / CIDR</option>
        </Select>
      </Field>
      <Field label="Destination">
        <Input
          required
          value={value.destination}
          maxLength={253}
          placeholder={
            value.kind === "domain" ? "registry.npmjs.org" : "192.0.2.10/32"
          }
          onChange={(e) => patch({ destination: e.target.value })}
        />
      </Field>
      {value.kind === "ip" && (
        <Field label="Transport">
          <Select
            value={value.transport}
            onChange={(v) =>
              patch({
                transport: v as Rule["transport"],
                ports: v === "icmp" ? "" : value.ports,
              })
            }
          >
            <option>tcp</option>
            <option>udp</option>
            <option>icmp</option>
            <option>any</option>
          </Select>
        </Field>
      )}
      <Field
        label="Allowed ports"
        hint={
          value.kind === "domain"
            ? "Domain rules use HTTP/TLS standard ports."
            : "Blank means all ports for this address and transport."
        }
      >
        {value.kind === "domain" ? (
          <Select value={value.ports} onChange={(v) => patch({ ports: v })}>
            <option value="443">HTTPS (443)</option>
            <option value="80">HTTP (80)</option>
            <option value="">HTTP and HTTPS</option>
            <option value="80,443">80,443</option>
            <option value="none">DNS only</option>
          </Select>
        ) : (
          <Input
            value={value.ports}
            disabled={value.transport === "icmp"}
            placeholder="443 or 8000:8100"
            onChange={(e) => patch({ ports: e.target.value })}
          />
        )}
      </Field>
      <Field
        label="Rule expiry"
        hint="Expiry removes network access, not the VM."
      >
        <Select
          value={String(value.ttlSeconds)}
          onChange={(v) => patch({ ttlSeconds: Number(v) })}
        >
          <option value="0">No expiry</option>
          <option value="3600">1 hour</option>
          <option value="86400">24 hours</option>
          <option value="604800">7 days</option>
          {![0, 3600, 86400, 604800].includes(value.ttlSeconds) && (
            <option value={value.ttlSeconds}>
              Remaining {Math.ceil(value.ttlSeconds / 60)} minutes
            </option>
          )}
        </Select>
      </Field>
      <Field label="Note">
        <Input
          value={value.note}
          maxLength={200}
          onChange={(e) => patch({ note: e.target.value })}
        />
      </Field>
    </div>
  );
}
function ProfileFields({
  value,
  onChange,
  bb = true,
}: {
  value: Profile;
  onChange(p: Profile): void;
  bb?: boolean;
}) {
  const { setup } = useManager();
  const patch = (p: Partial<Profile>) => onChange({ ...value, ...p });
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Dummie host">
          <Select value={value.host} onChange={(v) => patch({ host: v })}>
            <option value="">Choose a connected host</option>
            {setup?.hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Kernel">
          <Select value={value.kernel} onChange={(v) => patch({ kernel: v })}>
            <option value="">Choose a kernel</option>
            {setup?.kernels.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="OS image">
          <Select value={value.image} onChange={(v) => patch({ image: v })}>
            <option value="">Choose an image</option>
            {setup?.images.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
                {i.sizeBytes
                  ? " · " + Math.round(i.sizeBytes / 1048576) + " MiB"
                  : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="CPUs">
          <Input
            required
            type="number"
            min={1}
            max={8}
            value={value.cpus}
            onChange={(e) => patch({ cpus: Number(e.target.value) })}
          />
        </Field>
        <Field
          label="Memory (MiB)"
          hint={bb ? "BB requires at least 1024 MiB." : undefined}
        >
          <Input
            required
            type="number"
            min={bb ? 1024 : 64}
            max={16384}
            value={value.memoryMiB}
            onChange={(e) => patch({ memoryMiB: Number(e.target.value) })}
          />
        </Field>
        <Field
          label="Disk size"
          hint="Persistent disk, for example 4G or 512M."
        >
          <Input
            required
            pattern="[1-9][0-9]*[MG]"
            value={value.disk}
            onChange={(e) => patch({ disk: e.target.value.toUpperCase() })}
          />
        </Field>
      </div>
      <details className="rounded-md border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium">
          Initial egress rules ({value.targets.length})
        </summary>
        <p className="my-3 text-xs text-muted-foreground">
          These allow destinations; they do not fix host forwarding. No blanket
          access is added automatically.
        </p>
        <div className="space-y-3">
          {value.targets.map((rule, i) => (
            <div
              className="rounded-md border border-border p-3 space-y-2"
              key={i}
            >
              <RuleFields
                value={rule}
                onChange={(r) =>
                  patch({
                    targets: value.targets.map((t, index) =>
                      index === i ? r : t,
                    ),
                  })
                }
              />
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  patch({
                    targets: value.targets.filter((_, index) => index !== i),
                  })
                }
              >
                Remove draft rule
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            disabled={value.targets.length >= 32}
            onClick={() => patch({ targets: [...value.targets, emptyRule()] })}
          >
            Add draft rule
          </Button>
        </div>
      </details>
    </div>
  );
}
function initialProfile(setup: Setup): Profile {
  return (
    setup.defaults ?? {
      host: setup.hosts[0]?.id || "",
      kernel: setup.kernels[0]?.id || "",
      image: setup.images[0]?.id || "",
      cpus: 1,
      memoryMiB: 2048,
      disk: "4G",
      targets: [],
    }
  );
}
function InventoryPage() {
  const { rpc, go } = useManager();
  const [search, setSearch] = useState(""),
    [query, setQuery] = useState(""),
    [status, setStatus] = useState("all"),
    [offset, setOffset] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setQuery(search), 250);
    return () => clearTimeout(t);
  }, [search]);
  const load = useCallback(
    () =>
      rpc.call("manager_inventory", {
        search: query,
        status,
        offset,
        limit: 20,
      }),
    [rpc, query, status, offset],
  );
  const state = useLoad<Inventory>(load, 5000);
  const check = useAction();
  return (
    <div className="space-y-4">
      {(state.data?.total ?? 0) > 5 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            Search and filter
          </summary>{" "}
          <div className="flex flex-wrap gap-2">
            <div className="min-w-0 flex-1 basis-48">
              <Input
                aria-label="Search VMs"
                placeholder="Search VM names"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setOffset(0);
                }}
              />
            </div>
            <div className="w-36">
              <Select
                label="Filter by state"
                value={status}
                onChange={(v) => {
                  setStatus(v);
                  setOffset(0);
                }}
              >
                <option value="all">All states</option>
                {["pending", "running", "stopped", "failed", "gone"].map(
                  (s) => (
                    <option key={s}>{s}</option>
                  ),
                )}
              </Select>
            </div>
            <Button
              variant="outline"
              disabled={state.loading}
              onClick={state.refresh}
            >
              Refresh
            </Button>
          </div>
        </details>
      )}
      <Alert>{state.error || check.error}</Alert>
      {state.data?.limited && (
        <Note>
          Search is bounded to the first {state.data.scanned} account records.
          Refine or inspect the remaining VMs in Dummie.
        </Note>
      )}
      {!state.data && (
        <p className="text-sm text-muted-foreground">Loading machines…</p>
      )}
      {state.data?.vms.length === 0 && (
        <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm">
          No machines yet. Choose Create machine to get started.
        </p>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        {state.data?.vms.map((vm) => (
          <button
            key={vm.id}
            onClick={() => go("vm/" + vm.id)}
            className="min-w-0 rounded-lg border border-border bg-card p-4 text-left hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <strong className="min-w-0 break-all">
                {vm.bb?.name || vm.name}
              </strong>
              <Badge>{friendlyState(vm.status)}</Badge>
            </div>
            <p className="mt-3 text-sm">
              {vm.cpus || "?"} CPU · <Size mib={vm.memoryMiB} /> RAM ·{" "}
              <Size mib={vm.diskMiB} /> disk
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              {vm.management === "bb"
                ? vm.bb?.status === "connected"
                  ? "Connected to BB"
                  : "Connecting to BB"
                : vm.management === "protected"
                  ? "Setup needs attention"
                  : "Not connected to BB"}
            </p>
            {vm.operation && (
              <p className="mt-2 text-xs">{vm.operation.message}</p>
            )}
          </button>
        ))}
      </div>
      {state.data && state.data.total > 20 && (
        <div className="flex flex-wrap justify-between items-center gap-2 text-sm">
          <span>
            {state.data.total} matching VMs
            {state.loading ? " · refreshing…" : ""}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={!offset}
              onClick={() => setOffset(Math.max(0, offset - 20))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              disabled={offset + 20 >= state.data.total}
              onClick={() => setOffset(offset + 20)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
      {!!state.data?.requests.some(
        (r) =>
          r.state !== "confirmed" || r.message.includes("could not be queued"),
      ) && (
        <details className="rounded-lg border border-border p-4">
          <summary className="cursor-pointer font-medium text-sm">
            Setups needing attention
          </summary>
          <div className="mt-3 space-y-3">
            {state.data.requests
              .filter(
                (r) =>
                  r.state !== "confirmed" ||
                  r.message.includes("could not be queued"),
              )
              .map((r) => (
                <div
                  key={r.key}
                  className="text-sm rounded-md border border-border p-3"
                >
                  <div className="flex flex-wrap justify-between gap-2">
                    <strong>{r.name}</strong>
                    <Badge>{friendlyState(r.state)}</Badge>
                  </div>
                  <p className="my-2 text-muted-foreground">{r.message}</p>
                  {r.vmId && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => go("vm/" + r.vmId)}
                    >
                      Open VM
                    </Button>
                  )}
                  {r.hostId && (
                    <a
                      className="underline"
                      href={"/settings/machines/" + r.hostId}
                    >
                      View setup progress
                    </a>
                  )}
                  {(r.state === "posting" ||
                    r.message.includes("could not be queued")) && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={check.busy}
                      onClick={() =>
                        void check.run(async () => {
                          await rpc.call("manager_request", { key: r.key });
                          state.refresh();
                        })
                      }
                    >
                      Check setup again
                    </Button>
                  )}
                </div>
              ))}
          </div>
        </details>
      )}
    </div>
  );
}
function CreatePage({
  initialRecipeId = "bb-enrolled",
}: {
  initialRecipeId?: string;
}) {
  const { rpc, setup, refreshSetup, go } = useManager();
  const action = useAction();
  const load = useCallback(() => rpc.call("recipes_list"), [rpc]);
  const recipes = useLoad(load);
  const [recipeId, setRecipeId] = useState(initialRecipeId);
  const recipe = recipes.data?.find((r) => r.id === recipeId);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [ack, setAck] = useState(false);
  const [customized, setCustomized] = useState(false);
  const applied = useRef("");
  useEffect(() => {
    let live = true;
    void rpc
      .call("suggest_name", { key })
      .then((r) => {
        if (live) setName((current) => current || r.name);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [rpc, key]);
  useEffect(() => {
    if (!setup || !recipe || applied.current === recipe.id + recipe.revision)
      return;
    applied.current = recipe.id + recipe.revision;
    if (!customized) setProfile(recipe.profile ?? initialProfile(setup));
  }, [setup, recipe, customized]);
  if (!setup || !profile || !recipe)
    return (
      <p className="text-sm text-muted-foreground">
        Loading machine options…<Alert>{recipes.error}</Alert>
      </p>
    );
  const diskMiB =
    Number(profile.disk.slice(0, -1)) * (profile.disk.endsWith("G") ? 1024 : 1);
  const fits =
    setup.quota.vcpu_used + profile.cpus <= setup.quota.vcpu_limit &&
    setup.quota.memory_used_mib + profile.memoryMiB <=
      setup.quota.memory_limit_mib &&
    setup.quota.disk_used_mib + diskMiB <= setup.quota.disk_limit_mib;
  const checkRequest = async () => {
    const r = await action.run(() => rpc.call("manager_request", { key }));
    if (r) setReceipt(r);
  };
  return (
    <div className="max-w-2xl space-y-5">
      <Button variant="ghost" onClick={() => go("")}>
        ← Machines
      </Button>
      <div>
        <h2 className="text-lg font-semibold">Create a machine</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose a name and how you want it set up.
        </p>
      </div>
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          void (async () => {
            const r = await action.run(() =>
              rpc.call("manager_create", {
                key,
                mode: recipe.mode,
                ...(name ? { name } : {}),
                recipeId: recipe.id,
                recipeRevision: recipe.revision,
                profile,
                acknowledgeHostNotice: ack,
              }),
            );
            if (r) {
              setReceipt(r);
              refreshSetup();
            }
          })();
        }}
      >
        <fieldset disabled={action.busy || !!receipt} className="space-y-5">
          <div className="flex items-start gap-2">
            <div className="flex-1">
              <Field
                label="Machine name"
                hint="Suggested name. You can change it before creating the machine."
              >
                <Input
                  value={name}
                  maxLength={52}
                  minLength={3}
                  pattern="[a-z0-9]+(-[a-z0-9]+)*"
                  placeholder="gentle-otter-284197"
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
            </div>
            <Button
              className="mt-6"
              type="button"
              variant="ghost"
              onClick={() => {
                setName("");
                setKey(crypto.randomUUID());
              }}
            >
              Suggest another
            </Button>
          </div>
          <Field label="Setup recipe">
            <Select value={recipeId} onChange={setRecipeId}>
              {(recipes.data ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>
          <p className="text-sm text-muted-foreground">
            {recipe.mode === "bb"
              ? "Creates a new machine and connects it to BB."
              : "Creates a new machine without connecting it to BB."}{" "}
            {recipe.builtin ? "" : recipe.description}
          </p>
          {recipe.id === "bb-enrolled" && (
            <p className="text-xs text-muted-foreground">
              Setup allows Node.js, npm and Ubuntu or Debian package mirrors to
              download the required tools.
            </p>
          )}
          <div className="rounded-lg border border-border p-3 text-sm">
            {profile.cpus} CPU · <Size mib={profile.memoryMiB} /> memory ·{" "}
            <Size mib={diskMiB} /> disk
          </div>
          <details className="rounded-lg border border-border p-4">
            <summary className="cursor-pointer text-sm font-medium">
              Advanced settings
            </summary>
            <div className="mt-4 space-y-4">
              {customized && (
                <div className="text-sm">
                  <p>
                    Your custom machine settings are kept when switching
                    recipes.
                  </p>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setProfile(recipe.profile ?? initialProfile(setup));
                      setCustomized(false);
                    }}
                  >
                    Use this recipe’s defaults
                  </Button>
                </div>
              )}
              <ProfileFields
                value={profile}
                onChange={(p) => {
                  setProfile(p);
                  setCustomized(true);
                }}
                bb={recipe.mode === "bb"}
              />
              {recipe.bootstrapScript && (
                <details className="text-sm">
                  <summary className="cursor-pointer">
                    View setup script
                  </summary>
                  <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap text-xs">
                    {recipe.bootstrapScript}
                  </pre>
                </details>
              )}
            </div>
          </details>
          {setup.hostNetworkNotice && (
            <label className="flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
              />
              I reviewed the connection requirements. {setup.hostNetworkNotice}
            </label>
          )}
        </fieldset>
        <Alert>{action.error}</Alert>
        {!fits && !receipt && (
          <Note>
            Not enough quota for this size. Change the advanced settings or
            review capacity in Settings.
          </Note>
        )}
        {!receipt && (
          <Button
            type="submit"
            disabled={
              action.busy ||
              !fits ||
              (!!setup.hostNetworkNotice && !ack) ||
              !profile.host ||
              !profile.kernel ||
              !profile.image
            }
          >
            {action.busy ? "Creating…" : "Create machine"}
          </Button>
        )}
      </form>
      {receipt && (
        <section className="space-y-3 rounded-lg border border-border p-4">
          <Badge>{friendlyState(receipt.state)}</Badge>
          <p role="status" className="text-sm">
            {receipt.message}
          </p>
          <div className="flex flex-wrap gap-2">
            {receipt.vmId && (
              <Button onClick={() => go("vm/" + receipt.vmId)}>
                Open machine
              </Button>
            )}
            {receipt.hostId && (
              <a
                className="inline-flex h-9 items-center rounded-md border border-border px-3 text-sm"
                href={"/settings/machines/" + receipt.hostId}
              >
                View setup progress
              </a>
            )}
            {(receipt.state === "posting" ||
              receipt.message.includes("could not be queued")) && (
              <Button
                variant="outline"
                disabled={action.busy}
                onClick={() => void checkRequest()}
              >
                Check setup again
              </Button>
            )}
          </div>
          <Button
            variant="ghost"
            disabled={receipt.state === "posting"}
            onClick={() => {
              setReceipt(null);
              setName("");
              setKey(crypto.randomUUID());
            }}
          >
            Create another machine
          </Button>
        </section>
      )}
    </div>
  );
}

function DefaultsPage() {
  const { rpc, setup, refreshSetup } = useManager();
  const [profile, setProfile] = useState<Profile | null>(null);
  const action = useAction();
  useEffect(() => {
    if (setup && !profile) setProfile(initialProfile(setup));
  }, [setup, profile]);
  if (!setup || !profile) return <p>Loading catalog and defaults…</p>;
  return (
    <div className="space-y-5">
      <form
        className="max-w-3xl rounded-lg border border-border p-4 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await rpc.call("manager_defaults", profile);
            action.setNotice(
              "Defaults saved for future machines. Existing VMs were not changed.",
            );
            refreshSetup();
          });
        }}
      >
        <h2 className="font-semibold">Defaults for future BB machines</h2>
        <fieldset disabled={action.busy}>
          <ProfileFields value={profile} onChange={setProfile} />
        </fieldset>
        <Alert>{action.error}</Alert>
        <Note>{action.notice}</Note>
        <Button disabled={action.busy} type="submit">
          {action.busy ? "Saving…" : "Save defaults"}
        </Button>
      </form>
      <div className="grid gap-4 lg:grid-cols-3">
        {(
          [
            ["Hosts", setup.hosts],
            ["Kernels", setup.kernels],
            ["OS images", setup.images],
          ] as const
        ).map(([label, rows]) => (
          <section
            className="min-w-0 rounded-lg border border-border p-4"
            key={label}
          >
            <h2 className="font-semibold">
              {label}{" "}
              <span className="text-muted-foreground">({rows.length})</span>
            </h2>
            <ul className="mt-3 space-y-3">
              {rows.map((r) => (
                <li className="text-sm break-words" key={r.id}>
                  <strong>{r.name}</strong>
                  {r.description && (
                    <p className="mt-1 text-muted-foreground">
                      {r.description}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {r.sizeBytes
                      ? Math.round(r.sizeBytes / 1048576) + " MiB"
                      : ""}
                    {r.source ? " · " + r.source : ""}
                  </p>
                </li>
              ))}
            </ul>
            {!rows.length && (
              <p className="mt-3 text-sm text-muted-foreground">
                No available entries.
              </p>
            )}
          </section>
        ))}
      </div>
      <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-2">
        {setup.capabilityNotes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </div>
  );
}
function IntegrationsPanel({ vm }: { vm: ManagedVm }) {
  const { rpc } = useManager();
  const action = useAction();
  const load = useCallback(
    () => rpc.call("integrations_status", { id: vm.id }),
    [rpc, vm.id],
  );
  const state = useLoad(load);
  const [editing, setEditing] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [detach, setDetach] = useState<{ id: string; name: string } | null>(
    null,
  );
  return (
    <section className="rounded-lg border border-border p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-medium">Repository access</h2>
        {state.data && (
          <a
            href={state.data.origin + "/integrations"}
            target="_blank"
            rel="noreferrer"
            className="text-sm underline"
          >
            Manage in Dummie
          </a>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        Connect this VM to your private repositories. Credentials stay in
        Dummie.
      </p>
      <Alert>{state.error || action.error}</Alert>
      <Note>{action.notice}</Note>
      <Button
        variant="ghost"
        disabled={state.loading || action.busy}
        onClick={state.refresh}
      >
        Refresh access
      </Button>
      {state.loading && !state.data && (
        <p className="text-sm">Loading integrations…</p>
      )}
      {state.data?.available.length === 0 && (
        <p className="text-sm">
          Create an integration in Dummie, then refresh here.
        </p>
      )}
      {state.data?.available.map((i) => {
        const attached = state.data!.attached.find((a) => a.id === i.id);
        return (
          <div key={i.id} className="border-t border-border pt-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <strong>{i.name}</strong>
                <p className="text-sm text-muted-foreground">
                  {!i.connected
                    ? "Not connected in Dummie"
                    : i.suspended
                      ? "Suspended in Dummie"
                      : attached
                        ? i.kind === "gitlab"
                          ? "Attached · Uses saved token permissions"
                          : `Attached · ${attached.repos.length} repositories selected`
                        : "Not attached"}
                  {i.readonly ? " · Read only" : " · Read and write"}
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  disabled={
                    action.busy ||
                    !i.connected ||
                    i.suspended ||
                    !["github", "gitlab"].includes(i.kind) ||
                    (i.kind === "gitlab" && !!attached)
                  }
                  onClick={() => {
                    setEditing(i.id);
                    setSelected(attached?.repos ?? []);
                  }}
                >
                  {attached
                    ? i.kind === "gitlab"
                      ? "Attached"
                      : "Choose repositories"
                    : "Attach"}
                </Button>
                {attached && (
                  <Button
                    variant="ghost"
                    disabled={action.busy}
                    onClick={() => setDetach({ id: i.id, name: i.name })}
                  >
                    Detach
                  </Button>
                )}
              </div>
            </div>
            {attached && attached.repos.length > 0 && (
              <p className="text-sm break-words">{attached.repos.join(", ")}</p>
            )}
            {editing === i.id && i.kind === "gitlab" && (
              <ReviewDialog
                open={true}
                onOpenChange={(open) => {
                  if (!open) setEditing(null);
                }}
                title={`Attach ${i.name}?`}
                description={`This gives ${vm.name} access to every repository allowed by the saved GitLab token${i.instance ? " on " + i.instance : ""}. Dummie does not support selecting individual GitLab repositories.`}
                busy={action.busy}
              >
                <p className="mt-3 text-sm">
                  {i.readonly
                    ? "This integration is read only."
                    : "This integration allows read and write operations permitted by its token."}
                </p>
                <Alert>{action.error}</Alert>
                <div className="mt-4 flex gap-2">
                  <Button
                    disabled={action.busy}
                    onClick={async () => {
                      const result = await action.run(() =>
                        rpc.call("integrations_save", {
                          id: vm.id,
                          expectedName: vm.name,
                          integrationId: i.id,
                          acceptTokenScope: true,
                          repos: [],
                        }),
                      );
                      if (result) {
                        action.setNotice(result.message);
                        setEditing(null);
                      }
                      state.refresh();
                    }}
                  >
                    Attach integration
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={action.busy}
                    onClick={() => setEditing(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </ReviewDialog>
            )}
            {editing === i.id && i.kind === "github" && (
              <div className="space-y-3">
                <p className="text-sm">
                  Only selected repositories will be enabled for this VM.
                </p>
                {!i.repos.length && !i.all_repos && (
                  <p className="text-sm">
                    Select repositories on this integration's Dummie page first,
                    then refresh here.
                  </p>
                )}
                {i.all_repos && (
                  <label className="block text-sm">
                    Repository paths, one per line
                    <textarea
                      className="mt-2 w-full min-h-24 rounded-md border border-input bg-transparent p-2"
                      aria-label="Repository paths"
                      value={selected.join("\n")}
                      disabled={action.busy}
                      onChange={(e) => setSelected(e.target.value.split("\n"))}
                    />
                  </label>
                )}
                <div className="max-h-64 overflow-auto space-y-2">
                  {i.repos.map((repo) => (
                    <label key={repo} className="flex gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={selected.includes(repo)}
                        disabled={action.busy}
                        onChange={(e) =>
                          setSelected((v) =>
                            e.target.checked
                              ? [...v, repo]
                              : v.filter((r) => r !== repo),
                          )
                        }
                      />
                      {repo}
                    </label>
                  ))}
                </div>
                <Button
                  disabled={action.busy || !selected.length}
                  onClick={async () => {
                    const result = await action.run(() =>
                      rpc.call("integrations_save", {
                        id: vm.id,
                        expectedName: vm.name,
                        integrationId: i.id,
                        repos: selected.map((r) => r.trim()).filter(Boolean),
                      }),
                    );
                    if (result) {
                      action.setNotice(result.message);
                      setEditing(null);
                    }
                    state.refresh();
                  }}
                >
                  Save repository access
                </Button>
                <Button
                  variant="ghost"
                  disabled={action.busy}
                  onClick={() => setEditing(null)}
                >
                  Cancel
                </Button>
              </div>
            )}
          </div>
        );
      })}
      {detach && (
        <ConfirmDialog
          title={`Detach ${detach.name}?`}
          description="This VM will lose this integration's repository access. The integration and repositories remain in Dummie."
          open={true}
          name={vm.name}
          busy={action.busy}
          error={action.error}
          onOpenChange={(open) => {
            if (!open) setDetach(null);
          }}
          onConfirm={async () => {
            const result = await action.run(() =>
              rpc.call("integrations_detach", {
                id: vm.id,
                expectedName: vm.name,
                integrationId: detach.id,
              }),
            );
            if (result) {
              action.setNotice(result.message);
              setDetach(null);
            }
            state.refresh();
          }}
        />
      )}
    </section>
  );
}

function DetailPage({ id }: { id: string }) {
  const { rpc, setup, go, refreshSetup } = useManager();
  const action = useAction();
  const load = useCallback(() => rpc.call("manager_detail", { id }), [rpc, id]);
  const state = useLoad<Detail>(load, 5000, action.pending);
  const [confirm, setConfirm] = useState<
      "remove" | "retryCleanup" | "enroll" | null
    >(null),
    [targetDelete, setTargetDelete] = useState<
      Detail["targets"][number] | null
    >(null),
    [editingTarget, setEditingTarget] = useState<string | null>(null),
    [rule, setRule] = useState<Rule>(emptyRule),
    [ports, setPorts] = useState(""),
    [defaultPort, setDefaultPort] = useState(8000),
    [defaultUser, setDefaultUser] = useState(""),
    [cpus, setCpus] = useState(1),
    [ram, setRam] = useState(1024),
    [disk, setDisk] = useState("4G");
  const initialized = useRef("");
  const vm = state.data?.vm;
  useEffect(() => {
    if (vm && initialized.current !== vm.id) {
      initialized.current = vm.id;
      setPorts(vm.publicPorts.join(","));
      setDefaultPort(vm.defaultPort);
      setDefaultUser(vm.defaultUser);
      setCpus(vm.cpus || 1);
      setRam(vm.memoryMiB || 1024);
      setDisk(
        vm.diskMiB >= 1024 && vm.diskMiB % 1024 === 0
          ? vm.diskMiB / 1024 + "G"
          : (vm.diskMiB || 4096) + "M",
      );
    }
  }, [vm]);
  const changed = async (fn: () => Promise<{ message: string }>) => {
    const r = await action.run(fn);
    if (r) {
      action.setNotice(r.message);
      state.refresh();
      refreshSetup();
    }
    return r;
  };
  const base = { id, expectedName: vm?.name || "" };
  if (!vm)
    return (
      <div className="space-y-4">
        <Button variant="outline" onClick={() => go("")}>
          Back to machines
        </Button>
        <Alert>{state.error}</Alert>
        <p>{state.data ? "VM no longer present." : "Loading VM…"}</p>
        <Note>{state.data?.operation?.message}</Note>
      </div>
    );
  return (
    <div className="space-y-5">
      <Button variant="ghost" onClick={() => go("")}>
        ← Machines
      </Button>
      <div className="flex flex-wrap justify-between items-start gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold break-all">
            {vm.bb?.name || vm.name}
          </h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge>{friendlyState(vm.status)}</Badge>
          <Badge>
            {vm.management === "plain"
              ? "Not connected to BB"
              : vm.management === "bb"
                ? vm.bb?.status === "connected"
                  ? "Connected to BB"
                  : "Connecting to BB"
                : "Needs attention"}
          </Badge>
        </div>
      </div>
      <Alert>{state.error || action.error}</Alert>
      <Note>{action.notice || vm.operation?.message}</Note>
      <div className="flex flex-wrap gap-2">
        {vm.bb && (
          <a
            className="inline-flex h-9 items-center rounded-md border border-border px-3 text-sm"
            href={"/settings/machines/" + vm.bb.hostId}
          >
            BB connection
          </a>
        )}
        {vm.management === "plain" &&
          !vm.expiresAt &&
          ["running", "stopped"].includes(vm.status) && (
            <Button
              disabled={
                action.busy ||
                (!!vm.operation &&
                  ["pending", "uncertain"].includes(vm.operation.state))
              }
              onClick={() => setConfirm("enroll")}
            >
              Connect to BB
            </Button>
          )}
        {(["start", "stop"] as const)
          .filter((kind) => vm.capabilities[kind])
          .map((kind) => (
            <Button
              key={kind}
              variant="outline"
              disabled={action.busy || !vm.capabilities[kind]}
              onClick={() =>
                void changed(() =>
                  rpc.call("manager_action", {
                    ...base,
                    action: kind,
                    confirmation: "",
                  }),
                )
              }
            >
              {kind === "start"
                ? "Start machine"
                : kind === "stop"
                  ? "Stop machine"
                  : "Check connection"}
            </Button>
          ))}
        {vm.capabilities.retryCleanup && (
          <Button
            variant="outline"
            disabled={action.busy}
            onClick={() => setConfirm("retryCleanup")}
          >
            Finish removing
          </Button>
        )}

        <Button
          variant="destructive"
          disabled={action.busy || !vm.capabilities.remove}
          onClick={() => setConfirm("remove")}
        >
          {vm.retainedDisk ? "Disconnect from BB" : "Delete VM"}
        </Button>
        <Button
          variant="ghost"
          disabled={state.loading}
          onClick={state.refresh}
        >
          Refresh
        </Button>
      </div>
      <BootstrapStatus vm={vm} />
      <IntegrationsPanel key={vm.id} vm={vm} />
      <NetworkPanel selector={{ vmId: id }} />

      <details className="rounded-lg border border-border p-4">
        <summary className="cursor-pointer font-medium text-sm">
          Advanced settings and machine details
        </summary>
        <div className="mt-4 space-y-5">
          <Note>{vm.capabilities.reason}</Note>

          <dl className="grid grid-cols-2 gap-3 rounded-lg border border-border p-4 text-sm sm:grid-cols-3">
            {[
              ["Dummie name", vm.name],
              ["CPU", vm.cpus + " CPU"],
              ["Memory", <Size mib={vm.memoryMiB} />],
              ["Disk", <Size mib={vm.diskMiB} />],
              ["Host", vm.hostName],
              ["Kernel", vm.kernelName],
              ["IP", vm.ip || "Not assigned"],
              ["Boot", vm.boot || "Not reported"],
              [
                "Created",
                vm.createdAt
                  ? new Date(vm.createdAt).toLocaleString()
                  : "Not reported",
              ],
              [
                "Reported",
                vm.reportedAt
                  ? new Date(vm.reportedAt).toLocaleString()
                  : "Not reported",
              ],
            ].map(([key, value]) => (
              <div className="min-w-0" key={String(key)}>
                <dt className="text-xs text-muted-foreground">{key}</dt>
                <dd className="mt-1 break-words">{value}</dd>
              </div>
            ))}
          </dl>
          {vm.error && <Alert>{vm.error}</Alert>}
          {vm.expiresAt && (
            <Note>
              This VM expires at {new Date(vm.expiresAt).toLocaleString()}. Its
              existing Dummie TTL can destroy its disk.
            </Note>
          )}
          <section className="grid gap-4 lg:grid-cols-2">
            <form
              className="rounded-lg border border-border p-4 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void changed(() =>
                  rpc.call("manager_edit", {
                    ...base,
                    kind: "ports",
                    defaultPort,
                    publicPorts: ports.trim()
                      ? ports.split(",").map((p) => Number(p.trim()))
                      : [],
                  }),
                );
              }}
            >
              <h3 className="font-semibold">Published ports</h3>
              <fieldset
                disabled={action.busy || !vm.capabilities.edit}
                className="space-y-3"
              >
                <Field label="Default port">
                  <Input
                    type="number"
                    min={1}
                    max={65535}
                    required
                    value={defaultPort}
                    onChange={(e) => setDefaultPort(Number(e.target.value))}
                  />
                </Field>
                <Field
                  label="Public ports"
                  hint="Comma-separated ports. Blank publishes no ports."
                >
                  <Input
                    value={ports}
                    onChange={(e) => setPorts(e.target.value)}
                    placeholder="8000,3000"
                  />
                </Field>
                <Button type="submit">Save ports</Button>
              </fieldset>
            </form>
            <form
              className="rounded-lg border border-border p-4 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void changed(() =>
                  rpc.call("manager_edit", {
                    ...base,
                    kind: "user",
                    defaultUser,
                  }),
                );
              }}
            >
              <h3 className="font-semibold">SSH / console session user</h3>
              <fieldset
                disabled={action.busy || !vm.capabilities.edit}
                className="space-y-3"
              >
                <Field
                  label="Default session user"
                  hint="Blank follows the image. This changes login sessions, not the running workload."
                >
                  <Input
                    maxLength={32}
                    value={defaultUser}
                    onChange={(e) => setDefaultUser(e.target.value)}
                  />
                </Field>
                <Button type="submit">Save session user</Button>
              </fieldset>
            </form>
            <form
              className="rounded-lg border border-border p-4 space-y-3 lg:col-span-2"
              onSubmit={(e) => {
                e.preventDefault();
                void changed(() =>
                  rpc.call("manager_edit", {
                    ...base,
                    kind: "size",
                    cpus,
                    memoryMiB: ram,
                    disk,
                  }),
                );
              }}
            >
              <h3 className="font-semibold">Resize a stopped plain VM</h3>
              <p className="text-xs text-muted-foreground">
                Disk can grow only. Guest filesystems may need expansion.
                Existing kernel changes are unavailable here.
              </p>
              <fieldset
                disabled={action.busy || !vm.capabilities.resize}
                className="space-y-3"
              >
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="CPUs">
                    <Input
                      type="number"
                      required
                      min={1}
                      max={8}
                      value={cpus}
                      onChange={(e) => setCpus(Number(e.target.value))}
                    />
                  </Field>
                  <Field label="Memory (MiB)">
                    <Input
                      type="number"
                      required
                      min={64}
                      max={16384}
                      value={ram}
                      onChange={(e) => setRam(Number(e.target.value))}
                    />
                  </Field>
                  <Field label="Disk size">
                    <Input
                      required
                      pattern="[1-9][0-9]*[MG]"
                      value={disk}
                      onChange={(e) => setDisk(e.target.value.toUpperCase())}
                    />
                  </Field>
                </div>
                <Button type="submit">Save size</Button>
              </fieldset>
            </form>
          </section>
          <section className="rounded-lg border border-border p-4 space-y-4">
            <h3 className="font-semibold">
              Egress destinations ({state.data?.targetCount ?? 0})
            </h3>
            <p className="text-xs text-muted-foreground">
              Policy depends on the host. Editing an expiring rule restarts its
              selected duration. General egress editing is read only for BB
              machines. Use Network access above for temporary web access.
            </p>
            {state.data?.targets.map((t) => (
              <div
                key={t.id}
                className="flex flex-wrap justify-between gap-3 border-b border-border pb-3 text-sm"
              >
                <div className="min-w-0 break-all">
                  <strong>{t.rule.destination}</strong>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t.rule.kind === "domain" ? "HTTP/TLS" : t.rule.transport} ·{" "}
                    {t.rule.ports || "all supported ports"}
                    {t.expiresAt
                      ? " · expires " + new Date(t.expiresAt).toLocaleString()
                      : ""}
                  </p>
                  {t.rule.note && <p className="text-xs">{t.rule.note}</p>}
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={action.busy || !vm.capabilities.egress}
                    onClick={() => {
                      setEditingTarget(t.id);
                      setRule(t.rule);
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={action.busy || !vm.capabilities.egress}
                    onClick={() => setTargetDelete(t)}
                  >
                    Remove access
                  </Button>
                </div>
              </div>
            ))}
            {(state.data?.targetCount || 0) >
              (state.data?.targets.length || 0) && (
              <Note>Only the first 200 rules are shown.</Note>
            )}
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void (async () => {
                  const r = await changed(() =>
                    rpc.call("manager_target_save", {
                      ...base,
                      ...(editingTarget ? { targetId: editingTarget } : {}),
                      rule,
                    }),
                  );
                  if (r) {
                    setEditingTarget(null);
                    setRule(emptyRule());
                  }
                })();
              }}
            >
              <h4 className="text-sm font-medium">
                {editingTarget ? "Edit destination" : "Add destination"}
              </h4>
              <fieldset
                disabled={action.busy || !vm.capabilities.egress}
                className="space-y-3"
              >
                <RuleFields value={rule} onChange={setRule} />
                <div className="flex gap-2">
                  <Button type="submit">
                    {editingTarget ? "Save destination" : "Add destination"}
                  </Button>
                  {editingTarget && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setEditingTarget(null);
                        setRule(emptyRule());
                      }}
                    >
                      Cancel edit
                    </Button>
                  )}
                </div>
              </fieldset>
            </form>
          </section>
        </div>
      </details>
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={
          confirm === "enroll"
            ? "Connect " + vm.name + " to BB?"
            : vm.retainedDisk
              ? "Disconnect " + vm.name + " from BB?"
              : confirm === "retryCleanup"
                ? "Retry permanent VM removal"
                : "Permanently remove " + vm.name + "?"
        }
        description={
          confirm === "enroll"
            ? "This sets up the tools BB needs and connects this machine. Your files are kept if setup fails or you disconnect it later. Setup needs access to the BB, Node.js, npm and package-mirror sites."
            : vm.retainedDisk
              ? "BB will remove its environments and revoke this connection. The existing Dummie VM and disk will be retained."
              : "This permanently deletes " +
                vm.name +
                " and its disk. Files cannot be recovered. " +
                (vm.management === "bb"
                  ? "BB will remove its environments, revoke enrollment, and delete the VM."
                  : "Dummie will destroy the guest before its record is purged.")
        }
        name={vm.name}
        busy={action.busy}
        error={action.error}
        onConfirm={(confirmation) => {
          void (async () => {
            if (confirm === "enroll") {
              const result = await action.run(() =>
                rpc.call("manager_enroll", base),
              );
              if (result) {
                setConfirm(null);
                window.location.assign("/settings/machines/" + result.hostId);
              }
              return;
            }
            const r = await changed(() =>
              rpc.call("manager_action", {
                ...base,
                action: confirm!,
                confirmation,
              }),
            );
            if (r) {
              setConfirm(null);
              if (confirm === "remove") go("");
            }
          })();
        }}
      />
      <ConfirmDialog
        open={!!targetDelete}
        onOpenChange={(open) => {
          if (!open) setTargetDelete(null);
        }}
        title="Remove network access?"
        description={
          "Remove the " +
          (targetDelete?.rule.destination || "") +
          " allowance from " +
          vm.name +
          ". Connections using it may stop working."
        }
        name={targetDelete?.rule.destination || ""}
        busy={action.busy}
        error={action.error}
        onConfirm={(confirmation) => {
          void (async () => {
            const r = await changed(() =>
              rpc.call("manager_target_remove", {
                ...base,
                targetId: targetDelete!.id,
                confirmation,
              }),
            );
            if (r) setTargetDelete(null);
          })();
        }}
      />
    </div>
  );
}
function BootstrapStatus({ vm }: { vm: ManagedVm }) {
  const { rpc } = useManager();
  const action = useAction();
  const [confirm, setConfirm] = useState(false);
  const load = useCallback(
    () => rpc.call("setup_status", { id: vm.id, expectedName: vm.name }),
    [rpc, vm.id, vm.name],
  );
  const state = useLoad(load, 5000, action.pending);
  if (!state.data && !state.error) return null;
  return (
    <section className="space-y-3 rounded-lg border border-border p-4">
      <h3 className="font-semibold">Setup</h3>
      <Alert>{state.error || action.error}</Alert>
      {state.data && (
        <>
          <p>
            {state.data.recipeName}{" "}
            <Badge>
              {state.data.state === "running"
                ? "Setting up"
                : state.data.state === "pending"
                  ? "Waiting for machine"
                  : friendlyState(state.data.state)}
            </Badge>
          </p>
          <Note>{state.data.message}</Note>
          {state.data.state === "uncertain" && (
            <Note>
              Setup may have stopped partway. You can retry it, stop the machine
              or remove it.
            </Note>
          )}
          {vm.management !== "plain" &&
            ["failed", "uncertain"].includes(state.data.state) && (
              <Note>
                The machine and files have been kept. Ask an agent to recover
                this machine’s setup; another machine is not needed.
              </Note>
            )}
          {state.data.log && (
            <details>
              <summary className="cursor-pointer text-sm text-muted-foreground">
                View setup log
              </summary>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">
                {state.data.log}
              </pre>
            </details>
          )}
          {vm.management === "plain" &&
            ["failed", "uncertain"].includes(state.data.state) && (
              <Button
                variant="outline"
                disabled={action.busy}
                onClick={() => setConfirm(true)}
              >
                Retry setup
              </Button>
            )}
        </>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Retry setup on this VM?"
        description="Review the log and guest first. A failed or interrupted script may have partially run. Only retry an idempotent script. No new VM is created."
        name={vm.name}
        busy={action.busy}
        error={action.error}
        onConfirm={(confirmation) =>
          void (async () => {
            const result = await action.run(() =>
              rpc.call("setup_retry", {
                id: vm.id,
                expectedName: vm.name,
                confirmation,
              }),
            );
            if (result) {
              setConfirm(false);
              state.refresh();
            }
          })()
        }
      />
    </section>
  );
}
function RecipesPage() {
  const { rpc, setup, go } = useManager();
  const load = useCallback(() => rpc.call("recipes_list"), [rpc]);
  const state = useLoad(load);
  const action = useAction();
  const [draft, setDraft] = useState<Recipe | null>(null);
  const [deleting, setDeleting] = useState<Recipe | null>(null);
  const update = (patch: Partial<Recipe>) =>
    setDraft((r) => (r ? { ...r, ...patch } : r));
  const fresh = () =>
    setDraft({
      id: crypto.randomUUID(),
      revision: 1,
      name: "My recipe",
      description: "",
      mode: "plain",
      profile: null,
      bootstrapScript: "set -eu\n# Add repeatable setup commands here.\n",
      timeoutSeconds: 900,
      builtin: false,
    });
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Setup recipes</h2>
        <Button onClick={fresh}>New recipe</Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Save setup once, then reuse it when creating a machine. You can
        customize either included recipe.
      </p>
      <Alert>{state.error || action.error}</Alert>
      <div className="grid gap-3 sm:grid-cols-2">
        {(state.data ?? []).map((r) => (
          <section
            key={r.id}
            className="space-y-3 rounded-lg border border-border p-4"
          >
            <div className="flex flex-wrap gap-2">
              <strong>{r.name}</strong>
              <Badge>{r.builtin ? "Included" : "Saved"}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {r.description || "No description"}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => go("create/" + r.id)}>
                Create machine
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={action.busy}
                onClick={() =>
                  setDraft(
                    r.builtin
                      ? {
                          ...r,
                          id: crypto.randomUUID(),
                          revision: 1,
                          name: r.name + " copy",
                          builtin: false,
                        }
                      : r,
                  )
                }
              >
                {r.builtin ? "Customize" : "Edit"}
              </Button>
            </div>
          </section>
        ))}
      </div>
      {draft && (
        <form
          className="space-y-4 rounded-lg border border-border p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void (async () => {
              const saved = await action.run(() =>
                rpc.call("recipes_save", draft),
              );
              if (saved) {
                setDraft(saved);
                state.refresh();
                action.setNotice(
                  "Recipe saved. Future machines will use these settings.",
                );
              }
            })();
          }}
        >
          <h3 className="font-semibold">
            {draft.builtin ? "Included recipe" : "Recipe editor"}
          </h3>
          <fieldset
            disabled={draft.builtin || action.busy}
            className="space-y-4"
          >
            <Field label="Recipe name">
              <Input
                value={draft.name}
                maxLength={80}
                required
                onChange={(e) => update({ name: e.target.value })}
              />
            </Field>
            <Field label="Description">
              <Input
                value={draft.description}
                maxLength={1000}
                onChange={(e) => update({ description: e.target.value })}
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.mode === "bb"}
                onChange={(e) =>
                  update({ mode: e.target.checked ? "bb" : "plain" })
                }
              />
              Connect to BB after setup
            </label>
            {draft.integrations?.map((integration) => (
              <div
                key={integration.integrationId}
                className="rounded-md border border-border p-3 text-sm space-y-2"
              >
                <p>
                  Automatically attaches <strong>{integration.name}</strong> on{" "}
                  {integration.origin}. The VM receives all repository access
                  allowed by its saved GitLab token, including permitted writes.
                </p>
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() => update({ integrations: [] })}
                >
                  Remove automatic attachment
                </Button>
              </div>
            ))}
            <Field
              label="Setup commands"
              hint="Runs as the machine’s default user. Use sudo if needed. Commands should be safe to run again. Don’t put passwords or tokens here."
            >
              <textarea
                className="w-full rounded-md border border-input bg-background p-3 font-mono text-xs"
                rows={8}
                maxLength={32768}
                value={draft.bootstrapScript}
                onChange={(e) => update({ bootstrapScript: e.target.value })}
              />
            </Field>
            <details className="rounded-md border border-border p-3">
              <summary className="cursor-pointer text-sm">
                Advanced recipe settings
              </summary>
              <div className="mt-3 space-y-4">
                {" "}
                <Field label="Maximum setup time (seconds)">
                  <Input
                    type="number"
                    min={30}
                    max={1800}
                    value={draft.timeoutSeconds}
                    onChange={(e) =>
                      update({ timeoutSeconds: Number(e.target.value) })
                    }
                  />
                </Field>
                <label className="flex gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={!!draft.profile}
                    disabled={!setup}
                    onChange={(e) =>
                      update({
                        profile:
                          e.target.checked && setup
                            ? initialProfile(setup)
                            : null,
                      })
                    }
                  />
                  Save machine size, image and network defaults
                </label>
                {draft.profile && (
                  <ProfileFields
                    value={draft.profile}
                    onChange={(profile) => update({ profile })}
                    bb={draft.mode === "bb"}
                  />
                )}
              </div>
            </details>
          </fieldset>
          <Note>
            {action.notice ||
              (draft.builtin
                ? "Duplicate this recipe to customize it."
                : "The script is stored in BB. No VM is created when saving a recipe.")}
          </Note>
          {!draft.builtin && (
            <Button type="submit" disabled={action.busy}>
              Save recipe
            </Button>
          )}
          {!draft.builtin && (
            <Button
              type="button"
              variant="ghost"
              disabled={action.busy}
              onClick={() =>
                setDraft({
                  ...draft,
                  id: crypto.randomUUID(),
                  revision: 1,
                  name: draft.name + " copy",
                  builtin: false,
                })
              }
            >
              Make a copy
            </Button>
          )}
          {state.data?.some((r) => r.id === draft.id && !r.builtin) && (
            <Button
              type="button"
              variant="ghost"
              disabled={action.busy}
              onClick={() => setDeleting(draft)}
            >
              Delete recipe
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
            Close editor
          </Button>
        </form>
      )}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete saved recipe?"
        description="Existing launches keep their pinned recipe snapshot. No VM is removed."
        name={deleting?.name ?? ""}
        busy={action.busy}
        error={action.error}
        onConfirm={() =>
          void (async () => {
            if (!deleting) return;
            const result = await action.run(() =>
              rpc.call("recipes_delete", {
                id: deleting.id,
                revision: deleting.revision,
              }),
            );
            if (result) {
              if (draft?.id === deleting.id) setDraft(null);
              setDeleting(null);
              state.refresh();
            }
          })()
        }
      />
    </div>
  );
}
function DiagnosticsPage() {
  const { rpc } = useManager();
  const load = useCallback(() => rpc.call("diagnostics"), [rpc]);
  const state = useLoad(load, 10000);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap justify-between gap-2">
        <h2 className="font-semibold">Connection diagnostics</h2>
        <a href="/settings/plugins/dummie" className="underline text-sm">
          Secure connection settings
        </a>
      </div>
      <p className="text-sm text-muted-foreground">
        Token, control endpoint and SSH identity settings are managed by BB.
        Secret values and private key paths are not returned by this manager.
      </p>
      <Alert>{state.error}</Alert>
      {state.data?.hostNetworkNotice && (
        <Note>{state.data.hostNetworkNotice}</Note>
      )}
      <div className="divide-y divide-border rounded-lg border border-border">
        {state.data?.checks.map((check) => (
          <div className="p-4 text-sm" key={check.name}>
            <strong>
              {check.ok ? "✓" : "○"} {check.name}
            </strong>
            <p className="mt-1 text-muted-foreground">{check.detail}</p>
          </div>
        ))}
      </div>
      <section className="rounded-lg border border-border p-4 space-y-2 text-sm">
        <h3 className="font-semibold">Workspace choices</h3>
        <p>
          <strong>Dummie VM</strong> creates a new machine and clones a
          Git-backed project through BB. A local folder is not automatically
          copied.
        </p>
        <p>
          <strong>Dummie scratch VM</strong> under No project creates a new
          machine with personal-workspace.
        </p>
        <p>
          To use an existing persistent VM, open its detail page and choose
          <strong> Connect to BB</strong>. After enrollment, select that
          existing machine in New Thread with Project checkout or a personal
          workspace.
        </p>
      </section>
    </div>
  );
}
function useNetwork(selector: NetworkSelector, interval = 15000) {
  const rpc = useRpc<typeof rpcContract>();
  const key = JSON.stringify(selector);
  const load = useCallback(
    () => rpc.call("network_status", JSON.parse(key)),
    [rpc, key],
  );
  return useLoad(load, interval);
}
function NetworkPanel({ selector }: { selector: NetworkSelector }) {
  const rpc = useRpc<typeof rpcContract>();
  const status = useNetwork(selector, 5000);
  const action = useAction();
  const [selected, setSelected] = useState<string | null>(null);
  const [ttl, setTtl] = useState<300 | 3600 | 86400>(3600);
  const [ports, setPorts] = useState<"443" | "80,443">("443");
  const data = status.data;
  const chosen = data?.blocks.find((b) => b.key === selected);
  const waiting = data?.blocks.filter((b) => !b.allowed) ?? [];
  const run = async (fn: () => Promise<{ message: string }>) => {
    const result = await action.run(fn);
    if (result) {
      action.setNotice(result.message);
      setSelected(null);
    }
    status.refresh();
  };
  return (
    <section className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">Network access</h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={status.refresh}
          disabled={status.loading}
        >
          Refresh
        </Button>
      </div>
      <Alert>{status.error || action.error}</Alert>
      <Note>{action.notice}</Note>
      {!data ? (
        <p className="text-sm text-muted-foreground">
          {status.loading
            ? "Checking this machine…"
            : "Network access is available for Dummie machines."}
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Recent blocks from {data.name}. Allow access temporarily, then retry
            the page or command.
          </p>
          {!data.available && (
            <Note>
              Dummie is not reporting blocked traffic for this machine.
            </Note>
          )}
          {data.available && !data.recording.lookups && (
            <Note>
              DNS block recording is off. Some blocked names may be missing.
            </Note>
          )}
          {data.available && waiting.length === 0 && (
            <p className="text-sm">
              No unresolved blocks reported in the last hour.
            </p>
          )}
          {waiting.map((b) => (
            <div
              key={b.key}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3"
            >
              <div className="min-w-0">
                <p className="break-all text-sm font-medium">{b.destination}</p>
                <p className="text-xs text-muted-foreground">
                  {b.kind === "lookup" ? "DNS blocked" : "Connection blocked"} ·{" "}
                  {b.attempts} attempts{b.port ? " · port " + b.port : ""}
                </p>
              </div>
              {b.canAllow ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={action.busy}
                  onClick={() => {
                    setSelected(b.key);
                    setTtl(3600);
                    setPorts("443");
                  }}
                >
                  Review access
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground">
                  Review in Dummie
                </span>
              )}
            </div>
          ))}
          {data.limited && (
            <Note>
              Showing the most recent 200 blocks. Dummie has more history.
            </Note>
          )}
          {chosen && !chosen.allowed && (
            <ReviewDialog
              open
              onOpenChange={(open) => {
                if (!open) setSelected(null);
              }}
              busy={action.busy}
              title={`Allow ${chosen.destination}?`}
              description="Dummie also matches subdomains of this name. This changes access only for this machine."
            >
              <form
                className="mt-4 space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(() =>
                    rpc.call("network_allow", {
                      selector,
                      expectedName: data.name,
                      blockKey: chosen.key,
                      ttlSeconds: ttl,
                      ports,
                    }),
                  );
                }}
              >
                <Field label="Access">
                  <Select
                    value={ports}
                    onChange={(v) => setPorts(v as typeof ports)}
                  >
                    <option value="443">HTTPS only (443)</option>
                    <option value="80,443">HTTP and HTTPS (80, 443)</option>
                  </Select>
                </Field>
                <Field label="Duration">
                  <Select
                    value={String(ttl)}
                    onChange={(v) => setTtl(Number(v) as typeof ttl)}
                  >
                    <option value="300">5 minutes</option>
                    <option value="3600">1 hour</option>
                    <option value="86400">24 hours</option>
                  </Select>
                </Field>
                <Alert>{action.error}</Alert>
                <div className="flex gap-2">
                  <Button type="submit" disabled={action.busy}>
                    {action.busy ? "Allowing…" : "Allow access"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={action.busy}
                    onClick={() => setSelected(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            </ReviewDialog>
          )}
          {data.grants.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium">Temporary access</h3>
              {data.grants.map((g) => (
                <div
                  key={g.id}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <div className="min-w-0">
                    <p className="break-all">{g.destination}</p>
                    <p className="text-xs text-muted-foreground">
                      {g.ports === "443" ? "HTTPS" : "HTTP and HTTPS"} · expires{" "}
                      {new Date(g.expiresAt).toLocaleString()}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={action.busy || !data.canManage}
                    onClick={() =>
                      void run(() =>
                        rpc.call("network_revoke", {
                          selector,
                          expectedName: data.name,
                          grantId: g.id,
                        }),
                      )
                    }
                  >
                    Remove access
                  </Button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
function NetworkThreadPanel({ threadId }: { threadId: string }) {
  return <NetworkPanel selector={{ threadId }} />;
}
function useNetworkVisible({ threadId }: { threadId: string }) {
  const state = useNetwork({ threadId }, 20000);
  return !!state.data || !!state.error;
}
function NetworkSummary({
  threadId,
  onToggle,
}: ExperimentalThreadContextSegmentProps) {
  const status = useNetwork({ threadId });
  const count = status.data?.blocks.filter((b) => !b.allowed).length ?? 0;
  return (
    <button type="button" className="text-xs underline" onClick={onToggle}>
      {count ? `${count} network blocks` : "Network access"}
    </button>
  );
}
function NetworkDetails({
  threadId,
  isExpanded,
}: ExperimentalThreadContextSegmentProps) {
  return isExpanded ? <NetworkPanel selector={{ threadId }} /> : null;
}
function RemoteEditor({
  id,
  saved,
  cancel,
}: {
  id?: string;
  saved(): void;
  cancel(): void;
}) {
  const { rpc } = useManager();
  const action = useAction();
  const [loading, setLoading] = useState(!!id);
  const [loadError, setLoadError] = useState("");
  const [form, setForm] = useState({
    executionHostId: "",
    label: "",
    controlUrl: "",
    token: "",
    sshHost: "",
    sshPort: 22,
    sshFingerprint: "",
    identityFile: "",
  });
  const machines = useLoad(
    useCallback(() => rpc.call("execution_machines"), [rpc]),
  );
  useEffect(() => {
    let disposed = false;
    if (id)
      void rpc
        .call("connection_details", { id })
        .then((value) => {
          if (!disposed) {
            setForm({
              executionHostId: value.executionHostId,
              label: value.label,
              controlUrl: value.controlUrl,
              token: "",
              sshHost: value.sshHost,
              sshPort: value.sshPort,
              sshFingerprint: value.sshFingerprint,
              identityFile: value.identityFile,
            });
            setLoading(false);
          }
        })
        .catch((e) => {
          if (!disposed) setLoadError(message(e));
        });
    return () => {
      disposed = true;
    };
  }, [rpc, id]);
  const text =
    (
      key:
        | "label"
        | "controlUrl"
        | "token"
        | "sshHost"
        | "sshFingerprint"
        | "identityFile",
    ) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((v) => ({ ...v, [key]: e.target.value }));
  return (
    <form
      className="space-y-4 rounded-lg border border-border p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(async () => {
          const result = await rpc.call("save_connection", {
            ...form,
            ...(id ? { id } : {}),
          });
          await rpc.call("select_connection", { connection: result.id });
          setForm((v) => ({ ...v, token: "" }));
          saved();
        });
      }}
    >
      <h2 className="font-semibold">{id ? "Edit remote" : "Add remote"}</h2>
      <Alert>{loadError || action.error}</Alert>
      <Field
        label="Connect through"
        hint="This machine needs access to this remote and its SSH key. The choice is saved separately for each remote."
      >
        <Select
          value={form.executionHostId}
          onChange={(executionHostId) =>
            setForm((v) => ({ ...v, executionHostId }))
          }
        >
          <option value="">BB server</option>
          {form.executionHostId &&
            !machines.data?.some((m) => m.id === form.executionHostId) && (
              <option value={form.executionHostId}>
                Selected machine unavailable
              </option>
            )}
          {(machines.data ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
              {m.status === "connected" ? "" : ` (${m.status})`}
            </option>
          ))}
        </Select>
        <Alert>{machines.error}</Alert>
      </Field>
      <Field label="Name">
        <Input
          required
          value={form.label}
          onChange={text("label")}
          placeholder="Work Dummie"
        />
      </Field>
      <Field
        label="Dummie address"
        hint={
          id
            ? "Add another remote to use a different address."
            : "The HTTPS address your team uses for Dummie."
        }
      >
        <Input
          required
          type="url"
          disabled={!!id}
          value={form.controlUrl}
          onChange={text("controlUrl")}
          placeholder="https://dummie.example.com"
        />
      </Field>
      <Field
        label="Personal access token"
        hint={
          id ? "Leave blank to keep your saved token." : "Saved securely in BB."
        }
      >
        <Input
          type="password"
          autoComplete="new-password"
          required={!id}
          value={form.token}
          onChange={text("token")}
        />
      </Field>
      <Field
        label="SSH proxy"
        hint="Ask your Dummie administrator for the proxy address and fingerprint."
      >
        <Input
          required
          value={form.sshHost}
          onChange={text("sshHost")}
          placeholder="dummieapps.example.com"
        />
      </Field>
      <Field label="SSH fingerprint">
        <Input
          required
          value={form.sshFingerprint}
          onChange={text("sshFingerprint")}
          placeholder="SHA256:..."
        />
      </Field>
      <details>
        <summary className="cursor-pointer text-sm">Advanced settings</summary>
        <div className="mt-3 space-y-3">
          <Field label="SSH port">
            <Input
              type="number"
              min={1}
              max={65535}
              value={form.sshPort}
              onChange={(e) =>
                setForm((v) => ({ ...v, sshPort: Number(e.target.value) }))
              }
            />
          </Field>
          <Field
            label="SSH key file"
            hint="Path on the machine selected above. Leave blank to use its SSH agent."
          >
            <Input value={form.identityFile} onChange={text("identityFile")} />
          </Field>
        </div>
      </details>
      <div className="flex gap-2">
        <Button type="submit" disabled={loading || action.busy}>
          Save remote
        </Button>
        <Button type="button" variant="ghost" onClick={cancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
function DummiePage({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const load = useCallback(() => rpc.call("manager_setup"), [rpc]);
  const setup = useLoad<Setup>(load);
  const connectionLoad = useCallback(() => rpc.call("connections"), [rpc]);
  const connections = useLoad(connectionLoad);
  const switchAction = useAction();
  const [connectionVersion, setConnectionVersion] = useState(0);
  const [editingRemote, setEditingRemote] = useState<string | null>(null);
  const switchRemote = async (value: string) => {
    const result = await switchAction.run(() =>
      rpc.call("select_connection", { connection: value }),
    );
    if (result) {
      connections.refresh();
      setup.clear();
      setup.refresh();
      setConnectionVersion((v) => v + 1);
      go("");
    }
  };
  const go = useCallback(
    (path: string) => navigate.toPluginPanel("machines", { subPath: path }),
    [navigate],
  );
  const path = (subPath || "").replace(/^\/+|\/+$/g, "");
  const current =
    path.startsWith("vm/") || path.startsWith("create") ? "" : path;
  const id = path.startsWith("vm/") ? path.slice(3) : "";
  return (
    <Context.Provider
      value={{
        rpc,
        setup: setup.data,
        setupError: setup.error,
        refreshSetup: setup.refresh,
        go,
      }}
    >
      <div className="h-full overflow-y-auto">
        <main className="mx-auto w-full max-w-6xl min-w-0 space-y-5 px-4 py-5 sm:px-6">
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold">Dummie</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Your development machines.
              </p>
            </div>
            {!path.startsWith("create") && (
              <Button onClick={() => go("create")}>Create machine</Button>
            )}
          </header>
          {connections.data && (
            <div className="flex flex-wrap items-center gap-3">
              <Field label="Remote">
                <Select
                  value={connections.data.active}
                  disabled={
                    switchAction.busy || !!id || path.startsWith("create")
                  }
                  onChange={(value) => void switchRemote(value)}
                >
                  {!connections.data.profiles.length && (
                    <option value="remote">Add your first remote</option>
                  )}
                  {connections.data.profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditingRemote("");
                  go("settings");
                }}
              >
                Add remote
              </Button>
            </div>
          )}
          <Alert>{connections.error || switchAction.error}</Alert>
          <nav
            aria-label="Dummie sections"
            className="flex flex-wrap gap-1 border-b border-border pb-2"
          >
            {[
              ["", "Machines"],
              ["recipes", "Recipes"],
              ["settings", "Settings"],
            ].map(([tab, label]) => (
              <Button
                key={tab}
                variant={
                  current === tab ||
                  (tab === "settings" &&
                    ["catalog", "diagnostics"].includes(current))
                    ? "secondary"
                    : "ghost"
                }
                size="sm"
                onClick={() => go(tab!)}
              >
                {label}
              </Button>
            ))}
          </nav>
          <Alert>{setup.error}</Alert>
          {setup.data?.hostNetworkNotice && path !== "diagnostics" && (
            <details className="rounded-lg border border-border p-3 text-sm">
              <summary className="cursor-pointer font-medium">
                Local host prerequisite for new guests
              </summary>
              <p className="mt-2 text-muted-foreground">
                {setup.data.hostNetworkNotice}
              </p>
            </details>
          )}
          <div key={connectionVersion}>
            {id ? (
              <DetailPage key={id} id={id} />
            ) : path === "create" || path.startsWith("create/") ? (
              <CreatePage
                key={path}
                initialRecipeId={path.slice(7) || "bb-enrolled"}
              />
            ) : path === "recipes" ? (
              <RecipesPage />
            ) : ["settings", "catalog", "diagnostics"].includes(path) ? (
              <div className="space-y-4">
                {editingRemote !== null ? (
                  <RemoteEditor
                    key={editingRemote}
                    id={editingRemote || undefined}
                    cancel={() => setEditingRemote(null)}
                    saved={() => {
                      setEditingRemote(null);
                      connections.refresh();
                      setup.clear();
                      setup.refresh();
                      setConnectionVersion((v) => v + 1);
                    }}
                  />
                ) : (
                  <section className="space-y-3 rounded-lg border border-border p-4">
                    <h2 className="font-semibold">Remotes</h2>
                    {(connections.data?.profiles ?? []).map((p) => (
                      <div
                        key={p.id}
                        className="flex items-center justify-between gap-3"
                      >
                        <div>
                          <p className="text-sm font-medium">{p.label}</p>
                          <p className="text-xs text-muted-foreground">
                            {p.origin}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditingRemote(p.id)}
                        >
                          Edit
                        </Button>
                      </div>
                    ))}
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setEditingRemote("")}
                    >
                      Add remote
                    </Button>
                  </section>
                )}
                {setup.data && <Quota setup={setup.data} />}
                <details className="rounded-lg border border-border p-4">
                  <summary className="cursor-pointer font-medium text-sm">
                    Machine defaults and images
                  </summary>
                  <div className="mt-4">
                    <DefaultsPage />
                  </div>
                </details>
                <details className="rounded-lg border border-border p-4">
                  <summary className="cursor-pointer font-medium text-sm">
                    Connection checks and troubleshooting
                  </summary>
                  <div className="mt-4">
                    <DiagnosticsPage />
                  </div>
                </details>
              </div>
            ) : (
              <InventoryPage />
            )}
          </div>
        </main>
      </div>
    </Context.Provider>
  );
}
function DummieRecipeInputs({
  value,
  onChange,
}: PluginMachineProviderInputsProps) {
  const rpc = useRpc<typeof rpcContract>();
  const load = useCallback(async () => {
    const [recipes, connections] = await Promise.all([
      rpc.call("recipes_list"),
      rpc.call("connections", null),
    ]);
    return {
      recipes: recipes.filter((r) => r.mode === "bb"),
      origin: connections.profiles.find((p) => p.id === connections.active)
        ?.origin,
    };
  }, [rpc]);
  const state = useLoad(load);
  const [open, setOpen] = useState(false);
  const current =
    value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const preferred = "bb-enrolled";
  const selected = state.data?.recipes.find(
    (r) => r.id === (current.recipeId ?? preferred),
  );
  const change = useRef(onChange);
  change.current = onChange;
  useEffect(() => {
    if (state.error) change.current({ status: "blocked", reason: state.error });
    else if (!state.data)
      change.current({ status: "blocked", reason: "Loading Dummie recipes…" });
    else if (!selected)
      change.current({
        status: "blocked",
        reason: "Choose an available Dummie recipe.",
      });
    else if (
      current.recipeId !== selected.id ||
      current.recipeRevision !== selected.revision
    )
      change.current({
        status: "ready",
        value: {
          ...current,
          recipeId: selected.id,
          recipeRevision: selected.revision,
        },
      });
  }, [state.data, state.error, selected, value]);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Setup: {selected?.name ?? "Choose recipe"}
      </Button>
      <ReviewDialog
        open={open}
        onOpenChange={setOpen}
        title="Dummie setup recipe"
        description="Creates a new VM using this recipe. Existing machines are unchanged. Agent account sign-in is configured separately."
      >
        <div className="space-y-3 mt-4">
          <Alert>{state.error}</Alert>
          <Field label="Setup recipe">
            <Select
              value={selected?.id ?? ""}
              disabled={!state.data}
              onChange={(id) => {
                const recipe = state.data?.recipes.find((r) => r.id === id);
                if (recipe)
                  onChange({
                    status: "ready",
                    value: {
                      ...current,
                      recipeId: recipe.id,
                      recipeRevision: recipe.revision,
                    },
                  });
              }}
            >
              {(state.data?.recipes ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>
          <Note>{selected?.description}</Note>
          <Button onClick={() => setOpen(false)}>Done</Button>
        </div>
      </ReviewDialog>
    </>
  );
}
export default definePluginApp((app) => {
  app.slots.experimental_machineProviderInputs({
    machineProviderId: "dummie",
    component: DummieRecipeInputs,
  });
  app.slots.experimental_tab({
    id: "network",
    title: "Network access",
    icon: "Globe",
    context: { kind: "thread" },
    availability: "action",
    layout: "padded",
    useVisible: useNetworkVisible,
    component: NetworkThreadPanel,
  });
  app.slots.experimental_threadContextSegment({
    id: "network",
    title: "Network access",
    group: "network",
    useVisible: useNetworkVisible,
    summary: NetworkSummary,
    details: NetworkDetails,
  });
  app.slots.navPanel({
    id: "machines",
    title: "Dummie",
    icon: "Server",
    path: "machines",
    component: DummiePage,
  });
});
