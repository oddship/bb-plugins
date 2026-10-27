import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentHost } from "./attachment-host";
const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function temporary() {
  const dir = await mkdtemp(join(tmpdir(), "mattermost-test-"));
  directories.push(dir);
  return dir;
}
test("downloads use isolated temp storage, share concurrent work and return bounded chunks", async () => {
  const temp = await temporary(),
    fileId = "a".repeat(26);
  const run = vi.fn(async (args: string[]) => {
    const path = join(args[3], "image.png");
    await writeFile(path, "0123456789");
    return JSON.stringify([
      {
        file_id: fileId,
        name: "image.png",
        size: 10,
        mime_type: "image/png",
        saved_to: path,
      },
    ]);
  });
  const host = new AttachmentHost(run);
  const [a, b] = await Promise.all([
    host.prepare(fileId, temp, new AbortController().signal),
    host.prepare(fileId, temp, new AbortController().signal),
  ]);
  expect(a.file).toEqual(b.file);
  expect(run).toHaveBeenCalledTimes(1);
  expect(
    Buffer.from(
      (await host.chunk(fileId, 3, 4, temp, new AbortController().signal))
        .base64,
      "base64",
    ).toString(),
  ).toBe("3456");
  expect(run.mock.calls[0][0].slice(0, 3)).toEqual([
    "download",
    fileId,
    "--output",
  ]);
  await expect(
    host.chunk(fileId, 0, 2 * 1024 * 1024, temp, new AbortController().signal),
  ).rejects.toThrow();
});
test("a download cannot escape its dedicated directory and failed downloads are removed", async () => {
  const temp = await temporary(),
    fileId = "b".repeat(26),
    outside = join(temp, "outside.txt");
  await writeFile(outside, "private");
  const host = new AttachmentHost(async () =>
    JSON.stringify([
      {
        file_id: fileId,
        name: "bad",
        size: 7,
        mime_type: "text/plain",
        saved_to: outside,
      },
    ]),
  );
  await expect(
    host.prepare(fileId, temp, new AbortController().signal),
  ).rejects.toThrow("escaped");
  expect(await readdir(temp)).toEqual(["outside.txt"]);
});
