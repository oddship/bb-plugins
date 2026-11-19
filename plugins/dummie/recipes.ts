import { createHash } from "node:crypto";
import type { BbPluginApi, MachineExecutor } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  recipeSchema,
  setupRunSchema,
  type Recipe,
} from "./manager-contract.js";

export const publishTools = `tools="$HOME/.local/share/bb-dummie/node/bin"
public=/opt/bb-dummie/bin
test -x "$tools/node" && test -x "$tools/npm"
sudo -n install -d -m 0755 /opt/bb-dummie
if [ -L "$public" ]; then
  if [ "$(readlink "$public")" != "$tools" ]; then
    echo "Dummie tools path belongs to another installation: $public" >&2
    exit 1
  fi
elif [ -e "$public" ]; then
  echo "Dummie tools path already exists: $public" >&2
  exit 1
else
  sudo -n ln -s "$tools" "$public"
fi
if [ -x /headless-shell/headless-shell ] && [ ! -e "$tools/chromium" ] && [ ! -L "$tools/chromium" ]; then
  ln -s /headless-shell/headless-shell "$tools/chromium"
fi
if [ ! -e "$tools/bun" ] && [ ! -L "$tools/bun" ]; then
  for candidate in "$HOME/.bun/bin/bun" /usr/local/bin/bun /usr/bin/bun; do
    if [ -x "$candidate" ]; then
      ln -s "$candidate" "$tools/bun"
      break
    fi
  done
fi
echo "Dummie tools available at $public"
`;

export const bbBootstrap = `set -eu
export PATH="$HOME/.local/share/bb-dummie/node/bin:$PATH"
missing=0
for tool in curl git make g++ python3 setsid sha256sum tar; do command -v "$tool" >/dev/null || missing=1; done
if [ "$missing" = 1 ]; then
  echo "Installing build tools"
  sudo -n apt-get update
  sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends build-essential python3 curl git ca-certificates xz-utils
fi
if ! "$HOME/.local/share/bb-dummie/node/bin/node" -e 'if(process.versions.bun || Number(process.versions.node.split(".")[0])<22)process.exit(1)' >/dev/null 2>&1 || [ ! -x "$HOME/.local/share/bb-dummie/node/bin/npm" ]; then
  case "$(uname -m)" in x86_64) arch=x64;; aarch64|arm64) arch=arm64;; *) echo "Unsupported Node architecture"; exit 1;; esac
  version=22.23.4
  archive="node-v$version-linux-$arch.tar.xz"
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  echo "Installing genuine Node.js $version for BB"
  curl --fail --silent --show-error --location --max-time 300 "https://nodejs.org/dist/v$version/$archive" -o "$work/$archive"
  curl --fail --silent --show-error --location --max-time 60 "https://nodejs.org/dist/v$version/SHASUMS256.txt" -o "$work/SHASUMS256.txt"
  (cd "$work"; awk -v file="$archive" '$2 == file {print}' SHASUMS256.txt > selected.sha256; test -s selected.sha256; sha256sum -c selected.sha256)
  mkdir -p "$HOME/.local/share/bb-dummie/node"
  tar -xJf "$work/$archive" --strip-components=1 -C "$HOME/.local/share/bb-dummie/node"
fi
hash -r
node -e 'if(process.versions.bun || Number(process.versions.node.split(".")[0])<22)process.exit(1)'
npm --version
${publishTools}
if command -v loginctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
  sudo -n loginctl enable-linger "$(id -un)"
  echo "Persistent BB user service enabled"
fi
echo "BB prerequisites ready"
`;
const builtin: Recipe[] = [
  {
    id: "bb-enrolled",
    revision: 8,
    name: "BB workspace",
    description:
      "Sets up the tools BB needs and connects your machine. Works with Ubuntu and Debian.",
    mode: "bb",
    profile: null,
    bootstrapScript: bbBootstrap,
    timeoutSeconds: 1200,
    builtin: true,
  },
  {
    id: "plain",
    revision: 1,
    name: "Basic machine",
    description:
      "Create a machine without connecting it to BB. Customize this recipe to add your own setup commands.",
    mode: "plain",
    profile: null,
    bootstrapScript: "",
    timeoutSeconds: 900,
    builtin: true,
  },
];
export function bootstrapTargets(recipe: Recipe) {
  if (recipe.bootstrapScript !== bbBootstrap) return [];
  return bootstrapPrerequisites();
}
export function bootstrapPrerequisites() {
  return [
    "nodejs.org",
    "registry.npmjs.org",
    "archive.ubuntu.com",
    "security.ubuntu.com",
    "ports.ubuntu.com",
    "deb.debian.org",
    "security.debian.org",
  ].map((destination) => ({
    kind: "domain" as const,
    destination,
    transport: "tcp" as const,
    ports:
      destination.endsWith("ubuntu.com") || destination.endsWith("debian.org")
        ? "80,443"
        : "443",
    note: "BB recipe prerequisites",
    ttl_seconds: 0,
  }));
}
export const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
export const setupScope = (origin: string, account: string, vm: string) =>
  digest([origin, account, vm]);
type Kv = BbPluginApi["storage"]["kv"];
export class Recipes {
  constructor(readonly kv: Kv) {}
  async list() {
    const keys = await this.kv.list("recipe:saved:");
    if (keys.length > 50) throw Error("Recipe limit exceeded.");
    return [
      ...builtin,
      ...(await Promise.all(
        keys.map(async (key) => recipeSchema.parse(await this.kv.get(key))),
      )),
    ];
  }
  async get(id: string, revision?: number) {
    const recipe = (await this.list()).find((r) => r.id === id);
    if (!recipe) throw Error("Recipe no longer exists. Refresh recipes.");
    if (revision !== undefined && recipe.revision !== revision)
      throw Error(
        "Recipe changed. Review its latest version before creating a VM.",
      );
    return recipe;
  }
  async save(value: Recipe) {
    const input = recipeSchema.parse(value);
    z.string().uuid().parse(input.id);
    if (input.builtin)
      throw Error("Duplicate an included recipe before editing it.");
    const old = (await this.list()).find((r) => r.id === input.id);
    if (old && old.revision !== input.revision)
      throw Error("Recipe changed in another window. Reload before saving.");
    if (!old && (await this.list()).length >= 52)
      throw Error("Save at most 50 custom recipes.");
    const saved = {
      ...input,
      revision: old ? old.revision + 1 : 1,
      builtin: false,
    };
    await this.kv.set("recipe:saved:" + saved.id, saved);
    return saved;
  }
  async remove(id: string, revision: number) {
    const old = await this.get(id, revision);
    if (old.builtin) throw Error("Included recipes cannot be deleted.");
    await this.kv.delete("recipe:saved:" + id);
    return { deleted: true as const };
  }
  async pin(key: string, id?: string, revision?: number, sourceKey?: string) {
    const saved = await this.kv.get("recipe:launch:" + key);
    if (saved) return recipeSchema.parse(saved);
    const inherited =
      sourceKey && !id ? await this.kv.get("recipe:launch:" + sourceKey) : null;
    const recipe = inherited
      ? recipeSchema.parse(inherited)
      : await this.get(id ?? "bb-enrolled", revision);
    await this.kv.set("recipe:launch:" + key, recipe);
    return recipe;
  }
}
export const runRecord = setupRunSchema.extend({
  recipe: recipeSchema,
  fingerprint: z.string(),
});
export class RecipeRunner {
  constructor(readonly kv: Kv) {}
  async persist(scope: string, record: z.infer<typeof runRecord>) {
    await this.kv.set("recipe:run:" + scope + ":" + record.fingerprint, record);
    await this.kv.set("recipe:run:" + scope, record);
  }
  async status(scope: string) {
    const raw = await this.kv.get("recipe:run:" + scope);
    return raw ? runRecord.parse(raw) : null;
  }
  async run(
    scope: string,
    recipe: Recipe,
    executor: MachineExecutor,
    signal: AbortSignal,
    retry = false,
  ) {
    const fingerprint = digest(recipe);
    const latest = await this.status(scope);
    const saved = await this.kv.get("recipe:run:" + scope + ":" + fingerprint);
    const old = saved
      ? runRecord.parse(saved)
      : latest?.fingerprint === fingerprint
        ? latest
        : null;
    if (
      !old &&
      latest &&
      ["running", "failed", "uncertain"].includes(latest.state) &&
      (!retry || latest.state === "running")
    )
      throw Error(
        "Finish or explicitly retry the previous bootstrap before applying a different recipe.",
      );
    if (old?.state === "complete" && old.fingerprint === fingerprint)
      return old;
    const marker = fingerprint;
    if (old && old.state !== "pending" && !retry) {
      let done = false;
      const probe = await executor.exec({
        command: [
          "sh",
          "-c",
          'test -f "$HOME/.local/state/bb-dummie/recipes/$1/done"',
          "recipe",
          marker,
        ],
        stdin: "",
        signal,
        timeoutMs: 15000,
        onOutput() {},
      });
      done = probe.exitCode === 0;
      const next = {
        ...old,
        state: done ? ("complete" as const) : ("uncertain" as const),
        message: done
          ? "Setup completed on the guest."
          : "Previous bootstrap did not confirm completion. Review its log, then explicitly retry an idempotent script.",
      };
      await this.persist(scope, next);
      if (!done) throw Error(next.message);
      return next;
    }
    let record: z.infer<typeof runRecord> = {
      recipe,
      fingerprint,
      recipeName: recipe.name,
      revision: recipe.revision,
      state: "running",
      message: "Running setup commands on your machine.",
      log: "",
    };
    await this.persist(scope, record);
    const wrapper = `set -eu
umask 077
state="$HOME/.local/state/bb-dummie/recipes/$1"
mkdir -p "$state"
if [ -f "$state/done" ]; then exit 0; fi
if [ "$2" = retry ] && [ -d "$state/lock" ]; then
  pid=$(cat "$state/lock/pid" 2>/dev/null || true)
  case "$pid" in ''|*[!0-9]*) echo "Unrecognized bootstrap lock; inspect the guest"; exit 73;; esac
  if kill -0 "$pid" 2>/dev/null; then echo "Bootstrap is still running"; exit 73; fi
  rm -f "$state/lock/pid"; rmdir "$state/lock"
fi
mkdir "$state/lock" || { echo "Bootstrap lock exists; inspect before retrying"; exit 73; }
echo "$$" > "$state/lock/pid"
trap 'rm -f "$state/script.sh" "$state/lock/pid"; rmdir "$state/lock"' EXIT
cat > "$state/script.sh"
sh "$state/script.sh" </dev/null
touch "$state/done"
`;
    let pendingWrite = Promise.resolve();
    let lastWrite = 0;
    try {
      const result = await executor.exec({
        command: [
          "sh",
          "-c",
          wrapper,
          "recipe",
          marker,
          retry ? "retry" : "run",
        ],
        stdin: recipe.bootstrapScript,
        signal,
        timeoutMs: recipe.timeoutSeconds * 1000,
        onOutput: (text) => {
          record.log = (record.log + text).slice(-8192);
          if (Date.now() - lastWrite >= 1000) {
            lastWrite = Date.now();
            const snapshot = { ...record };
            pendingWrite = pendingWrite
              .then(() => this.persist(scope, snapshot))
              .catch(() => {});
          }
        },
      });
      record = {
        ...record,
        state: result.exitCode === 0 ? "complete" : "failed",
        message:
          result.exitCode === 0
            ? "Setup completed."
            : `Setup exited ${result.exitCode}. Review the log and egress rules before retrying.`,
      };
    } catch {
      record = {
        ...record,
        state: "uncertain",
        message:
          "Setup connection interrupted or timed out. VM retained. Review the guest before explicitly retrying.",
      };
    }
    await pendingWrite;
    await this.persist(scope, record);
    if (record.state !== "complete") throw Error(record.message);
    return record;
  }
}
