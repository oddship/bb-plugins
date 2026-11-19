import { createHash } from "node:crypto";
const adjectives =
  "amber bright calm clever coral cozy crisp eager gentle golden happy hazel jade jolly kind lively lucky mellow misty nimble noble olive quiet rapid silver snowy sunny swift tidy vivid warm wild".split(
    " ",
  );
const animals =
  "badger beaver bison crane deer dolphin eagle falcon finch fox gecko heron ibis koala lark lemur lynx marten moose otter owl panda penguin puffin raven robin seal sparrow tiger turtle whale wren".split(
    " ",
  );
/** Stable across retries; the persisted intent remains the allocation identity. */
export function friendlyName(scope: string, key: string) {
  const h = createHash("sha256")
    .update(JSON.stringify([scope, key]))
    .digest();
  return `${adjectives[h[0]! % adjectives.length]}-${animals[h[1]! % animals.length]}-${String(h.readUInt32BE(2) % 1000000).padStart(6, "0")}`;
}
