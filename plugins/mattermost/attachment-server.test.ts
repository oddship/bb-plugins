import { expect, test, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  registerAttachmentRoute,
  byteRange,
  safeMime,
} from "./attachment-server";
const id = "a".repeat(26),
  host = "host_test";
const url = "/attachment?" + new URLSearchParams({ fileId: id, hostId: host });
function setup(mime = "image/png", size = 10) {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE attachments(host TEXT,file TEXT,name TEXT,mime TEXT,size INTEGER,bytes BLOB,fetched INTEGER,accessed INTEGER,PRIMARY KEY(host,file))",
  );
  const app = new Hono();
  const remote = {
    prepare: vi.fn(async () => ({
      id,
      name: "work file.png",
      mime_type: mime,
      size,
    })),
    chunk: vi.fn(
      async (_host: string, _file: string, offset: number, length: number) => ({
        base64: Buffer.from(
          "0123456789".slice(offset, offset + length),
        ).toString("base64"),
      }),
    ),
  };
  registerAttachmentRoute(
    {
      http: {
        route: (method: string, path: string, handler: any) =>
          app.on(method, path, handler),
      },
    } as unknown as BbPluginApi,
    db as unknown as Pick<Database.Database, "prepare">,
    remote,
    () => host,
    new AbortController().signal,
  );
  return { app, db, remote };
}
test("single byte ranges and suffix ranges are bounded", () => {
  expect(byteRange("bytes=2-5", 10)).toMatchObject({
    start: 2,
    end: 5,
    partial: true,
  });
  expect(byteRange("bytes=-3", 10)).toMatchObject({ start: 7, end: 9 });
  expect(byteRange("bytes=8-", 10)).toMatchObject({ start: 8, end: 9 });
  for (const range of [
    "bytes=10-",
    "bytes=5-2",
    "bytes=-0",
    "bytes=0-2,5-8",
    "x=1-2",
  ])
    expect(byteRange(range, 10)).toBeNull();
});
test("HTML, SVG and unknown MIME types cannot render active content on BB's origin", () => {
  for (const mime of [
    "text/html",
    "image/svg+xml",
    "application/javascript",
    "text/html\r\nX: y",
  ])
    expect(safeMime(mime)).toBe("application/octet-stream");
  expect(safeMime("image/png")).toBe("image/png");
  expect(safeMime("application/json")).toMatch(/^text\/plain/);
});
test("attachments download once, persist as binary in SQLite and support range responses", async () => {
  const { app, db, remote } = setup();
  const first = await app.request(url);
  expect(first.status).toBe(200);
  expect(await first.text()).toBe("0123456789");
  const second = await app.request(url, { headers: { Range: "bytes=3-6" } });
  expect(second.status).toBe(206);
  expect(second.headers.get("Content-Range")).toBe("bytes 3-6/10");
  expect(await second.text()).toBe("3456");
  expect(remote.prepare).toHaveBeenCalledTimes(1);
  expect(remote.chunk).toHaveBeenCalledTimes(1);
  expect(remote.chunk.mock.calls[0][0]).toBe(host);
  const download = await app.request(url + "&download=1");
  expect(download.headers.get("Content-Disposition")).toMatch(/^attachment;/);
  expect(download.headers.get("X-Content-Type-Options")).toBe("nosniff");
  db.close();
});
test("cross-site, invalid IDs and mismatched hosts cannot invoke Mattermost downloads", async () => {
  const { app, db, remote } = setup();
  expect(
    (await app.request(url, { headers: { "Sec-Fetch-Site": "cross-site" } }))
      .status,
  ).toBe(403);
  expect(
    (await app.request("/attachment?fileId=../../secret&hostId=" + host))
      .status,
  ).toBe(400);
  expect((await app.request(url.replace(host, "host_other"))).status).toBe(409);
  expect(remote.prepare).not.toHaveBeenCalled();
  db.close();
});
test("large attachments stream requested ranges without loading the whole file into server memory", async () => {
  const { app, db, remote } = setup("video/mp4", 5 * 1024 * 1024);
  const response = await app.request(url, { headers: { Range: "bytes=2-5" } });
  expect(response.status).toBe(206);
  expect(await response.text()).toBe("2345");
  expect(remote.chunk.mock.calls[0].slice(2, 4)).toEqual([2, 4]);
  expect(
    (
      db.prepare("SELECT COUNT(*) AS count FROM attachments").get() as {
        count: number;
      }
    ).count,
  ).toBe(0);
  db.close();
});
test("failed transfers return a useful error and do not cache incomplete files", async () => {
  const { app, db, remote } = setup();
  remote.chunk.mockRejectedValueOnce(new Error("offline"));
  const response = await app.request(url);
  expect(response.status).toBe(502);
  expect(await response.text()).toContain("Retry");
  expect(
    (
      db.prepare("SELECT COUNT(*) AS count FROM attachments").get() as {
        count: number;
      }
    ).count,
  ).toBe(0);
  db.close();
});
