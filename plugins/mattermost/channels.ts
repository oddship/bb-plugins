import type { Channel } from "./contract";

export const channelSortOptions = {
  recent: "Most recent activity",
  oldest: "Oldest activity",
  az: "Name A–Z",
  za: "Name Z–A",
} as const;
export type ChannelSort = keyof typeof channelSortOptions;
const names = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});
const label = (channel: Channel) =>
  (channel.name ?? channel.channel ?? "").replace(/^@/, "");
const timestamp = (channel: Channel) => {
  const value = Date.parse(channel.last_post_at ?? "");
  return Number.isFinite(value) ? value : null;
};

export function sortChannels(
  channels: Channel[],
  sort: ChannelSort,
): Channel[] {
  return channels.slice().sort((a, b) => {
    const alphabetical = names.compare(label(a), label(b));
    if (sort === "az" || sort === "za")
      return (
        (sort === "az" ? alphabetical : -alphabetical) ||
        (a.id ?? a.channel_id ?? "").localeCompare(b.id ?? b.channel_id ?? "")
      );
    const at = timestamp(a),
      bt = timestamp(b);
    // Unknown activity always goes last, including when ordering oldest first.
    if (at === null || bt === null)
      return at === bt ? alphabetical : at === null ? 1 : -1;
    return (sort === "recent" ? bt - at : at - bt) || alphabetical;
  });
}
