import { expect, test } from "vitest";
import { sortChannels } from "./channels";
const channels = [
  { id: "a", name: "Zulu", last_post_at: "2026-10-20T12:00:00Z" },
  { id: "b", name: "@alice", type: "DM", last_post_at: "2026-10-27T12:00:00Z" },
  { id: "c", name: "Beta", last_post_at: "2026-10-25T12:00:00Z" },
  { id: "d", name: "Unknown" },
];
test("recent and oldest activity use timestamps and keep missing dates last", () => {
  expect(sortChannels(channels, "recent").map((c) => c.id)).toEqual([
    "b",
    "c",
    "a",
    "d",
  ]);
  expect(sortChannels(channels, "oldest").map((c) => c.id)).toEqual([
    "a",
    "c",
    "b",
    "d",
  ]);
});
test("alphabetical sorts include DMs by username without the @ prefix", () => {
  expect(sortChannels(channels, "az").map((c) => c.id)).toEqual([
    "b",
    "c",
    "d",
    "a",
  ]);
  expect(sortChannels(channels, "za").map((c) => c.id)).toEqual([
    "a",
    "d",
    "c",
    "b",
  ]);
});
test("sorting leaves shared cached data unchanged", () => {
  const original = channels.map((c) => c.id);
  sortChannels(channels, "recent");
  expect(channels.map((c) => c.id)).toEqual(original);
});
