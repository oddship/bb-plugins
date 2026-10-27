import type { Post } from "./contract";
export const conversationId = (p: Post) => p.thread_id || p.id;
const time = (p: Post) => Date.parse(p.created_at) || 0;
export function chronological(posts: Post[]) {
  const unique = new Map<string, Post>();
  posts.forEach((p, i) => unique.set(p.id ?? "unknown:" + i, p));
  return [...unique.values()].sort((a, b) => time(a) - time(b));
}
export function splitThread(posts: Post[], target: string) {
  const ordered = chronological(posts);
  const canonical = ordered.find((p) => p.thread_id)?.thread_id ?? target;
  const root = ordered.find((p) => p.id === canonical || p.is_reply === false);
  const replies = ordered.filter((p) => p !== root);
  const total = root?.reply_count;
  return {
    root,
    replies,
    missing:
      typeof total === "number" ? Math.max(0, total - replies.length) : null,
    canonical,
  };
}
export function groupConversations(posts: Post[]) {
  const groups = new Map<string, Post[]>();
  posts.forEach((p, i) => {
    const id = conversationId(p) ?? "unknown:" + i;
    const group = groups.get(id) ?? [];
    group.push(p);
    groups.set(id, group);
  });
  return [...groups]
    .map(([id, items]) => {
      const ordered = chronological(items);
      const root = ordered.find((p) => p.id === id || p.is_reply === false);
      const replies = ordered.filter((p) => p !== root);
      const latest = ordered.at(-1)!;
      return {
        id,
        root,
        preview: root ?? ordered[0],
        latest,
        replyCount: Math.max(root?.reply_count ?? 0, replies.length),
        participants: [...new Set(ordered.map((p) => p.author))],
        posts: ordered,
      };
    })
    .sort((a, b) => time(b.latest) - time(a.latest));
}
