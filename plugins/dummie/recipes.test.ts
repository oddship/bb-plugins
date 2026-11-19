import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  readFile,
  mkdir,
  writeFile,
  readlink,
  symlink,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { MachineExecutor } from "@get-bb/plugin-sdk";
import {
  Recipes,
  RecipeRunner,
  bbBootstrap,
  publishTools,
  bootstrapTargets,
} from "./recipes.js";
import { friendlyName } from "./names.js";
import { vmName, type Recipe } from "./manager-contract.js";

test("friendly names are readable, scoped, valid and stable across retries", () => {
  const one = friendlyName("account-a", "stable-key");
  assert.match(one, /^[a-z]+-[a-z]+-\d{6}$/);
  assert.equal(vmName.parse(one), one);
  assert.equal(friendlyName("account-a", "stable-key"), one);
  assert.notEqual(friendlyName("account-b", "stable-key"), one);
  assert.notEqual(friendlyName("account-a", "another-key"), one);
});
test("saved recipes use optimistic revisions and launch snapshots survive edits/deletion", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "dummie" });
  try {
    const store = new Recipes(bb.storage.kv);
    const included = await store.get("bb-enrolled");
    assert.equal(included.bootstrapScript, bbBootstrap);
    const draft: Recipe = {
      ...included,
      id: "10000000-0000-4000-8000-000000000099",
      name: "My recipe",
      builtin: false,
    };
    const first = await store.save(draft);
    const snapshot = await store.pin("launch", first.id, first.revision);
    const second = await store.save({
      ...first,
      bootstrapScript: "echo changed",
    });
    assert.equal(second.revision, 2);
    await assert.rejects(store.save(first), /another window/);
    await assert.rejects(store.get(first.id, first.revision), /changed/);
    await store.remove(second.id, second.revision);
    assert.deepEqual(await store.pin("launch", first.id), snapshot);
    assert.deepEqual(
      await store.pin("recovery", undefined, undefined, "launch"),
      snapshot,
    );
    await assert.rejects(
      store.remove("bb-enrolled", included.revision),
      /Included/,
    );
  } finally {
    await harness.lifecycle.dispose();
  }
});
function localExecutor(root: string, loseReply = false): MachineExecutor {
  return {
    async exec(request) {
      const argv = request.command.map((arg) => arg.replaceAll("$HOME", root));
      return await new Promise((resolve, reject) => {
        const child = spawn(argv[0]!, argv.slice(1));
        child.stdout.on("data", (b) => request.onOutput(String(b)));
        child.stderr.on("data", (b) => request.onOutput(String(b)));
        child.on("error", reject);
        // Status probes can exit before consuming stdin. Their exit code remains authoritative.
        child.stdin.on("error", (error: NodeJS.ErrnoException) => {
          if (error.code !== "EPIPE") reject(error);
        });
        child.on("close", (code) =>
          loseReply && request.stdin
            ? reject(Error("reply lost"))
            : resolve({ exitCode: code ?? 255 }),
        );
        child.stdin.end(request.stdin);
      });
    },
  };
}
test("completed bootstrap is not repeated after a lost reply or a restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "bb-recipe-test-"));
  const { bb, harness } = createFakePluginHost({ pluginId: "dummie" });
  try {
    const base = await new Recipes(bb.storage.kv).get("plain");
    const recipe = {
      ...base,
      bootstrapScript: `cat >/dev/null\necho ran >> '${root}/counter'\necho setup-ok\n`,
    };
    const runner = new RecipeRunner(bb.storage.kv);
    await assert.rejects(
      runner.run(
        "scope",
        recipe,
        localExecutor(root, true),
        AbortSignal.timeout(3000),
      ),
      /interrupted/,
    );
    assert.equal((await runner.status("scope"))!.state, "uncertain");
    const resumed = new RecipeRunner(bb.storage.kv);
    assert.equal(
      (
        await resumed.run(
          "scope",
          recipe,
          localExecutor(root),
          AbortSignal.timeout(3000),
        )
      ).state,
      "complete",
    );
    await resumed.run(
      "scope",
      recipe,
      localExecutor(root),
      AbortSignal.timeout(3000),
    );
    assert.equal(await readFile(join(root, "counter"), "utf8"), "ran\n");
    const followup = {
      ...recipe,
      id: "followup",
      bootstrapScript: `echo second >> '${root}/counter'\n`,
    };
    await resumed.run(
      "scope",
      followup,
      localExecutor(root),
      AbortSignal.timeout(3000),
    );
    await resumed.run(
      "scope",
      recipe,
      localExecutor(root),
      AbortSignal.timeout(3000),
    );
    assert.equal(
      await readFile(join(root, "counter"), "utf8"),
      "ran\nsecond\n",
    );
  } finally {
    await harness.lifecycle.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
test("failed scripts retain bounded logs and require an explicit retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "bb-recipe-test-"));
  const { bb, harness } = createFakePluginHost({ pluginId: "dummie" });
  try {
    const recipe = {
      ...(await new Recipes(bb.storage.kv).get("plain")),
      bootstrapScript: `echo attempt >> '${root}/counter'\nif [ ! -f '${root}/once' ]; then touch '${root}/once'; echo failure; exit 7; fi\necho success\n`,
    };
    const runner = new RecipeRunner(bb.storage.kv);
    await assert.rejects(
      runner.run(
        "scope",
        recipe,
        localExecutor(root),
        AbortSignal.timeout(3000),
      ),
      /exited 7/,
    );
    assert.match((await runner.status("scope"))!.log, /failure/);
    await assert.rejects(
      runner.run(
        "scope",
        recipe,
        localExecutor(root),
        AbortSignal.timeout(3000),
      ),
      /explicitly retry/,
    );
    assert.equal(await readFile(join(root, "counter"), "utf8"), "attempt\n");
    assert.equal(
      (
        await runner.run(
          "scope",
          recipe,
          localExecutor(root),
          AbortSignal.timeout(3000),
          true,
        )
      ).state,
      "complete",
    );
    assert.equal(
      await readFile(join(root, "counter"), "utf8"),
      "attempt\nattempt\n",
    );
  } finally {
    await harness.lifecycle.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("publishing Dummie tools is repeatable and refuses unrelated paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "bb-tools-test-"));
  const tools = join(root, ".local/share/bb-dummie/node/bin");
  const publicDir = join(root, "opt/bb-dummie");
  const publicPath = join(publicDir, "bin");
  try {
    await mkdir(tools, { recursive: true });
    const bun = join(root, ".bun/bin/bun");
    await mkdir(join(root, ".bun/bin"), { recursive: true });
    await writeFile(bun, "#!/bin/sh\necho bun-fixture\n", { mode: 0o700 });
    for (const name of ["node", "npm"])
      await writeFile(join(tools, name), "#!/bin/sh\nexit 0\n", {
        mode: 0o700,
      });
    const script =
      'set -eu; umask 077; sudo() { shift; "$@"; }; ' +
      publishTools.replaceAll("/opt/bb-dummie", publicDir);
    const run = () =>
      spawnSync("sh", ["-c", script], {
        env: { ...process.env, HOME: root },
        encoding: "utf8",
      });
    assert.equal(run().status, 0);
    assert.equal(await readlink(publicPath), tools);
    assert.equal((await stat(publicDir)).mode & 0o777, 0o755);
    assert.equal(await readlink(join(tools, "bun")), bun);
    assert.equal(run().status, 0);
    await rm(join(tools, "bun"));
    await writeFile(join(tools, "bun"), "existing Bun wrapper");
    assert.equal(run().status, 0);
    assert.equal(
      await readFile(join(tools, "bun"), "utf8"),
      "existing Bun wrapper",
    );
    await rm(publicPath);
    await symlink(join(root, "another-installation"), publicPath);
    assert.notEqual(run().status, 0);
    assert.equal(
      await readlink(publicPath),
      join(root, "another-installation"),
    );
    await rm(publicPath);
    await mkdir(publicPath);
    await writeFile(join(publicPath, "keep"), "existing user tools");
    assert.notEqual(run().status, 0);
    assert.equal(
      await readFile(join(publicPath, "keep"), "utf8"),
      "existing user tools",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("BB setup permits Debian package downloads while plain recipes add no destinations", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "dummie" });
  try {
    const recipes = new Recipes(bb.storage.kv);
    const targets = bootstrapTargets(await recipes.get("bb-enrolled"));
    for (const domain of ["deb.debian.org", "security.debian.org"]) {
      const rule = targets.find((r) => r.destination === domain);
      assert.equal(rule?.ports, "80,443");
      assert.equal(rule?.transport, "tcp");
    }
    assert.deepEqual(bootstrapTargets(await recipes.get("plain")), []);
  } finally {
    await harness.lifecycle.dispose();
  }
});
