import { expect, test } from "vitest";
import { groupConversations, splitThread } from "./threading";
import type { Post } from "./contract";
const root: Post = {
  id: "a".repeat(26),
  thread_id: "a".repeat(26),
  author: "@root",
  message: "Original question",
  created_at: "2026-10-27T10:00:00Z",
  is_reply: false,
  reply_count: 150,
};
const reply = (id: string, date: string): Post => ({
  id: id.repeat(26),
  thread_id: root.id,
  is_reply: true,
  author: "@reply",
  message: "Reply " + id,
  created_at: date,
});
test("channel activity groups replies under their canonical root without duplicates", () => {
  const r = reply("b", "2026-10-27T11:00:00Z");
  const groups = groupConversations([r, root, r]);
  expect(groups).toHaveLength(1);
  expect(groups[0].posts).toHaveLength(2);
  expect(groups[0].preview).toEqual(root);
  expect(groups[0].replyCount).toBe(150);
  expect(groups[0].latest).toEqual(r);
});
test("a missing original is explicitly represented rather than promoting a reply", () => {
  const r = reply("b", "2026-10-27T11:00:00Z");
  expect(groupConversations([r])[0].root).toBeUndefined();
  expect(splitThread([r], root.id!).root).toBeUndefined();
});
test("thread separates the original, chronological replies, and omitted reply count", () => {
  const r1 = reply("b", "2026-10-27T11:00:00Z"),
    r2 = reply("c", "2026-10-27T12:00:00Z");
  const thread = splitThread([r2, root, r1], r1.id!);
  expect(thread.canonical).toBe(root.id);
  expect(thread.root).toEqual(root);
  expect(thread.replies).toEqual([r1, r2]);
  expect(thread.missing).toBe(148);
});
test("conversations sort by latest activity instead of root creation date", () => {
  const newer = {
    ...root,
    id: "d".repeat(26),
    thread_id: "d".repeat(26),
    created_at: "2026-10-27T10:30:00Z",
  };
  expect(
    groupConversations([newer, root, reply("b", "2026-10-27T12:00:00Z")])[0].id,
  ).toBe(root.id);
});
