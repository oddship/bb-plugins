import { expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type Database from "better-sqlite3";
import { createStarStore } from "./stars";
const schema =
  "CREATE TABLE stars(host TEXT NOT NULL,conversation TEXT NOT NULL,title TEXT NOT NULL,created TEXT NOT NULL,pinned INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(host,conversation))";
test("personal stars persist across store recreation and stay scoped to their host", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  const store = createStarStore(
    db as unknown as Pick<Database.Database, "prepare">,
  );
  store.change("host_a", "a".repeat(26), "Work topic", "star");
  const reopened = createStarStore(
    db as unknown as Pick<Database.Database, "prepare">,
  );
  expect(reopened.list("host_a")).toHaveLength(1);
  expect(reopened.list("host_b")).toEqual([]);
  db.close();
});
test("pin implies star, sorts first, unpin keeps star and unstar removes both", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  const store = createStarStore(
      db as unknown as Pick<Database.Database, "prepare">,
    ),
    a = "a".repeat(26),
    b = "b".repeat(26);
  store.change("host", a, "A", "star");
  store.change("host", b, "B", "pin");
  expect(store.list("host")[0]).toMatchObject({
    conversationId: b,
    pinned: true,
  });
  store.change("host", b, "B", "unpin");
  expect(store.list("host")).toHaveLength(2);
  expect(store.list("host").find((s) => s.conversationId === b)?.pinned).toBe(
    false,
  );
  store.change("host", b, "B", "pin");
  store.change("host", b, "B", "unstar");
  expect(store.list("host").map((s) => s.conversationId)).toEqual([a]);
  db.close();
});
