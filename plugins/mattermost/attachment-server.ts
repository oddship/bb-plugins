import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import { mattermostId, fileSchema, type Attachment } from "./contract";
import { MAX_FILE_BYTES } from "./attachment-host";

export function safeMime(raw: string) {
  const mime = raw.split(";")[0].trim().toLowerCase();
  if (
    /^(image\/(png|jpeg|gif|webp|avif)|audio\/(mpeg|mp4|ogg|wav|webm|x-wav)|video\/(mp4|webm|ogg)|application\/pdf)$/.test(
      mime,
    )
  )
    return mime;
  if (/^(text\/(plain|csv|markdown)|application\/json)$/.test(mime))
    return "text/plain; charset=utf-8";
  return "application/octet-stream";
}
export function byteRange(header: string | undefined, size: number) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || !size) return null;
  let start = match[1]
    ? Number(match[1])
    : Math.max(0, size - Number(match[2]));
  let end = match[1] ? (match[2] ? Number(match[2]) : size - 1) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  )
    return null;
  end = Math.min(end, size - 1);
  return { start, end, partial: true };
}
type Remote = {
  prepare: (
    hostId: string,
    fileId: string,
    signal: AbortSignal,
  ) => Promise<Attachment>;
  chunk: (
    hostId: string,
    fileId: string,
    offset: number,
    length: number,
    signal: AbortSignal,
  ) => Promise<{ base64: string }>;
};
export function registerAttachmentRoute(
  bb: BbPluginApi,
  db: Pick<Database.Database, "prepare">,
  remote: Remote,
  needHost: () => string,
  lifecycle: AbortSignal,
) {
  bb.http.route("GET", "/attachment", async (c) => {
    const fileId = c.req.query("fileId"),
      requestedHost = c.req.query("hostId");
    if (!mattermostId.safeParse(fileId).success)
      return c.text("Invalid attachment ID.", 400);
    if (c.req.header("Sec-Fetch-Site") === "cross-site")
      return c.text("Attachment requires the BB app.", 403);
    const hostId = needHost();
    if (requestedHost !== hostId)
      return c.text("Mattermost host changed. Reopen this attachment.", 409);
    const controller = new AbortController();
    const signal = AbortSignal.any([
      lifecycle,
      c.req.raw.signal,
      controller.signal,
    ]);
    try {
      const saved = db
        .prepare(
          "SELECT name,mime,size,bytes FROM attachments WHERE host=? AND file=? AND fetched>?",
        )
        .get(hostId, fileId, Date.now() - 7 * 86400_000) as
        { name: string; mime: string; size: number; bytes: Buffer } | undefined;
      const metadata = saved
        ? {
            id: fileId!,
            name: saved.name,
            mime_type: saved.mime,
            size: saved.size,
          }
        : fileSchema.parse(await remote.prepare(hostId, fileId!, signal));
      if (metadata.id !== fileId)
        throw new Error("Attachment identity mismatch.");
      const size = metadata.size ?? 0;
      if (size > MAX_FILE_BYTES)
        return c.text("Open attachments over 64 MiB in Mattermost.", 413);
      let data = saved?.bytes;
      if (saved)
        db.prepare(
          "UPDATE attachments SET accessed=? WHERE host=? AND file=?",
        ).run(Date.now(), hostId, fileId);
      if (!data && size <= 4 * 1024 * 1024) {
        const chunks: Buffer[] = [];
        for (let offset = 0; offset < size;) {
          const bytes = Buffer.from(
            (
              await remote.chunk(
                hostId,
                fileId!,
                offset,
                Math.min(1024 * 1024, size - offset),
                signal,
              )
            ).base64,
            "base64",
          );
          if (!bytes.length || bytes.length > size - offset)
            throw new Error("Incomplete attachment.");
          chunks.push(bytes);
          offset += bytes.length;
        }
        data = Buffer.concat(chunks);
        db.prepare(
          "INSERT OR REPLACE INTO attachments(host,file,name,mime,size,bytes,fetched,accessed) VALUES(?,?,?,?,?,?,?,?)",
        ).run(
          hostId,
          fileId,
          metadata.name,
          metadata.mime_type ?? "",
          size,
          data,
          Date.now(),
          Date.now(),
        );
        db.prepare("DELETE FROM attachments WHERE fetched<?").run(
          Date.now() - 7 * 86400_000,
        );
        while (
          (
            db
              .prepare(
                "SELECT COALESCE(SUM(size),0) AS bytes,COUNT(*) AS count FROM attachments",
              )
              .get() as { bytes: number; count: number }
          ).bytes >
            64 * 1024 * 1024 ||
          (
            db.prepare("SELECT COUNT(*) AS count FROM attachments").get() as {
              count: number;
            }
          ).count > 64
        )
          db.prepare(
            "DELETE FROM attachments WHERE rowid=(SELECT rowid FROM attachments ORDER BY accessed LIMIT 1)",
          ).run();
      }
      const range = byteRange(c.req.header("Range"), size);
      if (!range)
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": "bytes */" + size },
        });
      const mime = safeMime(metadata.mime_type ?? "");
      const download =
        c.req.query("download") === "1" || mime === "application/octet-stream";
      const filename = encodeURIComponent(metadata.name.slice(0, 250)).replace(
        /['()*]/g,
        (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase(),
      );
      const headers: Record<string, string> = {
        "Content-Type": mime,
        "Content-Length": String(Math.max(0, range.end - range.start + 1)),
        "Content-Disposition":
          (download ? "attachment" : "inline") +
          "; filename=\"attachment\"; filename*=UTF-8''" +
          filename,
        "Accept-Ranges": "bytes",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "private, max-age=300",
      };
      if (range.partial)
        headers["Content-Range"] =
          "bytes " + range.start + "-" + range.end + "/" + size;
      const status = range.partial ? 206 : 200;
      if (data)
        return new Response(
          new Uint8Array(data.subarray(range.start, range.end + 1)),
          { status, headers },
        );
      let offset = range.start;
      const body = new ReadableStream<Uint8Array>({
        async pull(stream) {
          if (offset > range.end) {
            stream.close();
            return;
          }
          try {
            const length = Math.min(1024 * 1024, range.end - offset + 1);
            const bytes = Buffer.from(
              (await remote.chunk(hostId, fileId!, offset, length, signal))
                .base64,
              "base64",
            );
            if (!bytes.length || bytes.length > length)
              throw new Error("Incomplete attachment.");
            offset += bytes.length;
            stream.enqueue(new Uint8Array(bytes));
          } catch {
            stream.error(
              new Error("Attachment transfer failed. Retry the download."),
            );
            controller.abort();
          }
        },
        cancel() {
          controller.abort();
        },
      });
      return new Response(body, { status, headers });
    } catch {
      return c.text(
        "Attachment could not be loaded. Retry, or open the message in Mattermost.",
        502,
      );
    }
  });
}
