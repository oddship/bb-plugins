import test from "node:test";
import assert from "node:assert/strict";
import { Api, TransientError } from "./api.js";
import {
  attachRecipeIntegrations,
  checkRecipeIntegrations,
} from "./recipe-integrations.js";
import { recipeSchema } from "./manager-contract.js";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { Recipes } from "./recipes.js";
const iid = "10000000-0000-4000-8000-000000000099";
const origin = "https://dummie.example.com";
const recipe = () =>
  recipeSchema.parse({
    id: iid,
    revision: 1,
    name: "Tech test",
    description: "",
    mode: "bb",
    profile: null,
    builtin: false,
    bootstrapScript: "",
    timeoutSeconds: 60,
    integrations: [
      {
        origin,
        integrationId: iid,
        name: "work",
        kind: "gitlab",
        acceptTokenScope: true,
      },
    ],
  });
function fixture() {
  const api = new Api(origin, "never-print");
  let attached = false;
  let loseReply = false;
  let confirm = true;
  const integration = {
    id: iid,
    name: "work",
    kind: "gitlab",
    connected: true,
    suspended: false,
  };
  const calls: string[] = [];
  api.request = async (path, signal, method = "GET") => {
    signal.throwIfAborted();
    calls.push(method + " " + path);
    if (path === `/integrations/${iid}`) return integration;
    if (path === "/vms/vm/integrations")
      return { items: attached && confirm ? [{ id: iid }] : [] };
    if (path === `/integrations/${iid}/vms/vm` && method === "POST") {
      attached = true;
      if (loseReply) {
        loseReply = false;
        throw new TransientError("lost reply");
      }
      return null;
    }
    throw Error("Unexpected API operation");
  };
  return {
    api,
    calls,
    integration,
    lose: () => {
      loseReply = true;
    },
    hide: () => {
      confirm = false;
    },
  };
}
const signal = () => new AbortController().signal;
test("recipe attachment is confirmed, idempotent and recovered after a lost reply", async () => {
  const f = fixture();
  f.lose();
  await assert.rejects(
    attachRecipeIntegrations(f.api, recipe(), "vm", signal()),
    /lost reply/,
  );
  await attachRecipeIntegrations(f.api, recipe(), "vm", signal());
  await attachRecipeIntegrations(f.api, recipe(), "vm", signal());
  assert.equal(f.calls.filter((c) => c.startsWith("POST")).length, 1);
  assert.equal(
    f.calls.some((c) => c.startsWith("DELETE") || c.startsWith("PUT")),
    false,
  );
});
test("integration preflight rejects wrong remote, identity, kind and unavailable integration", async () => {
  const f = fixture();
  const r = recipe();
  r.integrations![0]!.origin = "https://other.example.com";
  await assert.rejects(
    checkRecipeIntegrations(f.api, r, signal()),
    /another Dummie remote/,
  );
  assert.equal(f.calls.length, 0);
  for (const patch of [
    { name: "other" },
    { kind: "github" },
    { connected: false },
    { suspended: true },
  ]) {
    const g = fixture();
    Object.assign(g.integration, patch);
    await assert.rejects(
      attachRecipeIntegrations(g.api, recipe(), "vm", signal()),
    );
    assert.equal(
      g.calls.some((c) => c.startsWith("POST")),
      false,
    );
  }
});
test("unconfirmed attachment blocks setup and generic recipes make no integration requests", async () => {
  const f = fixture();
  f.hide();
  await assert.rejects(
    attachRecipeIntegrations(f.api, recipe(), "vm", signal()),
    /could not be confirmed/,
  );
  assert.equal(f.calls.filter((c) => c.startsWith("POST")).length, 1);
  const r = recipe();
  delete r.integrations;
  f.calls.length = 0;
  await attachRecipeIntegrations(f.api, r, "vm", signal());
  assert.deepEqual(f.calls, []);
});
test("saved integration choice is pinned per launch and recipe edits affect future launches", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "dummie" });
  try {
    const recipes = new Recipes(bb.storage.kv);
    const saved = await recipes.save(recipe());
    const first = await recipes.pin("first", saved.id, saved.revision);
    const changed = await recipes.save({ ...saved, integrations: [] });
    assert.deepEqual(
      (await recipes.pin("first")).integrations,
      first.integrations,
    );
    assert.deepEqual(
      (await recipes.pin("second", changed.id, changed.revision)).integrations,
      [],
    );
    assert.equal(first.integrations?.[0]?.name, "work");
  } finally {
    await harness.lifecycle.dispose();
  }
});
