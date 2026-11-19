import { z } from "zod";
import { Api } from "./api.js";
import { integrationSchema, type Recipe } from "./manager-contract.js";

/** Control-plane attachment. Recipe snapshots contain identity and consent, never tokens. */
export async function checkRecipeIntegrations(
  api: Api,
  recipe: Recipe,
  signal: AbortSignal,
) {
  for (const requested of recipe.integrations ?? []) {
    if (requested.origin !== api.origin)
      throw Error(
        "This recipe's repository integration belongs to another Dummie remote. Select its original remote or use another recipe.",
      );
    const integration = integrationSchema.parse(
      await api.request(`/integrations/${requested.integrationId}`, signal),
    );
    if (
      integration.id !== requested.integrationId ||
      integration.name !== requested.name ||
      integration.kind !== requested.kind
    )
      throw Error(
        "The recipe's repository integration changed. Review and save the recipe again.",
      );
    if (!integration.connected || integration.suspended)
      throw Error(
        `Connect the ${requested.name} integration in Dummie before using this recipe.`,
      );
  }
}

export async function attachRecipeIntegrations(
  api: Api,
  recipe: Recipe,
  vmId: string,
  signal: AbortSignal,
) {
  if (!recipe.integrations?.length) return;
  await checkRecipeIntegrations(api, recipe, signal);
  const list = z.object({
    items: z.array(z.object({ id: z.string() })).max(200),
  });
  let attached = list.parse(
    await api.request(`/vms/${encodeURIComponent(vmId)}/integrations`, signal),
  ).items;
  for (const requested of recipe.integrations) {
    if (attached.some((i) => i.id === requested.integrationId)) continue;
    await api.request(
      `/integrations/${requested.integrationId}/vms/${encodeURIComponent(vmId)}`,
      signal,
      "POST",
    );
    attached = list.parse(
      await api.request(
        `/vms/${encodeURIComponent(vmId)}/integrations`,
        signal,
      ),
    ).items;
    if (!attached.some((i) => i.id === requested.integrationId))
      throw Error(
        `Attachment of ${requested.name} could not be confirmed. The VM was retained; inspect Repository access before retrying setup.`,
      );
  }
}
