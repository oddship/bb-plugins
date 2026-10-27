import type Database from "better-sqlite3";
import { starSchema, type StarredConversation } from "./contract";
export function createStarStore(db: Pick<Database.Database, "prepare">) {
  const list = (host: string): StarredConversation[] =>
    db
      .prepare(
        "SELECT conversation AS conversationId,title,created AS createdAt,pinned FROM stars WHERE host=? ORDER BY pinned DESC,created DESC,conversation LIMIT 500",
      )
      .all(host)
      .map((row) => {
        const value = row as Record<string, unknown>;
        return starSchema.parse({ ...value, pinned: !!value.pinned });
      });
  return {
    list,
    change(
      host: string,
      id: string,
      title: string,
      action: "star" | "unstar" | "pin" | "unpin",
    ) {
      if (action === "unstar")
        db.prepare("DELETE FROM stars WHERE host=? AND conversation=?").run(
          host,
          id,
        );
      else if (action === "unpin")
        db.prepare(
          "UPDATE stars SET pinned=0 WHERE host=? AND conversation=?",
        ).run(host, id);
      else {
        const existing = db
          .prepare("SELECT pinned FROM stars WHERE host=? AND conversation=?")
          .get(host, id) as { pinned: number } | undefined;
        if (!existing && list(host).length >= 500)
          throw new Error(
            "You have 500 starred conversations. Remove a star first.",
          );
        db.prepare(
          "INSERT INTO stars(host,conversation,title,created,pinned) VALUES(?,?,?,?,?) ON CONFLICT(host,conversation) DO UPDATE SET title=excluded.title,pinned=excluded.pinned",
        ).run(
          host,
          id,
          title,
          new Date().toISOString(),
          action === "pin" ? 1 : (existing?.pinned ?? 0),
        );
      }
      return list(host);
    },
  };
}
