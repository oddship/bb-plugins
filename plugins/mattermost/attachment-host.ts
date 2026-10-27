import { mkdtemp, realpath, stat, rm, open } from "node:fs/promises";
import { join, sep } from "node:path";
import { z } from "zod";
import { fileSchema, type Attachment, mattermostId } from "./contract";
import { runMm } from "./mm";

export const MAX_FILE_BYTES = 64 * 1024 * 1024;
type Prepared = {
  file: Attachment;
  path: string;
  directory: string;
  accessed: number;
};
const record = z.object({
  file_id: mattermostId,
  name: z.string(),
  size: z.number(),
  mime_type: z.string(),
  saved_to: z.string(),
});
export class AttachmentHost {
  private saved = new Map<string, Prepared>();
  private pending = new Map<string, Promise<Prepared>>();
  constructor(private run = runMm) {}
  async prepare(
    fileId: string,
    tempDir: string,
    signal: AbortSignal,
  ): Promise<Prepared> {
    mattermostId.parse(fileId);
    const cached = this.saved.get(fileId);
    if (cached) {
      cached.accessed = Date.now();
      return cached;
    }
    const pending = this.pending.get(fileId);
    if (pending) return pending;
    if (this.pending.size >= 6)
      throw new Error("Too many attachment downloads. Try again shortly.");
    const job = this.download(fileId, tempDir, signal);
    this.pending.set(fileId, job);
    try {
      return await job;
    } finally {
      this.pending.delete(fileId);
    }
  }
  private async download(fileId: string, tempDir: string, signal: AbortSignal) {
    const directory = await mkdtemp(join(tempDir, "mattermost-file-"));
    try {
      const raw = JSON.parse(
        await this.run(["download", fileId, "--output", directory], signal),
      );
      const metadata = z.array(record).length(1).parse(raw)[0];
      if (metadata.file_id !== fileId)
        throw new Error("Attachment identity mismatch.");
      const path = await realpath(metadata.saved_to),
        root = await realpath(directory);
      if (!path.startsWith(root + sep))
        throw new Error("Attachment path escaped its download directory.");
      const info = await stat(path);
      if (!info.isFile() || info.size > MAX_FILE_BYTES)
        throw new Error(
          "Attachments over 64 MiB must be opened in Mattermost.",
        );
      const file = fileSchema.parse({
        id: fileId,
        name: metadata.name.slice(0, 250),
        mime_type: metadata.mime_type,
        size: info.size,
      });
      const saved = { file, path, directory, accessed: Date.now() };
      this.saved.set(fileId, saved);
      let total = [...this.saved.values()].reduce(
        (n, v) => n + (v.file.size ?? 0),
        0,
      );
      for (const [id, old] of [...this.saved].sort(
        (a, b) => a[1].accessed - b[1].accessed,
      )) {
        if (this.saved.size <= 64 && total <= 128 * 1024 * 1024) break;
        if (id === fileId) continue;
        this.saved.delete(id);
        total -= old.file.size ?? 0;
        await rm(old.directory, { recursive: true, force: true });
      }
      return saved;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  async chunk(
    fileId: string,
    offset: number,
    length: number,
    tempDir: string,
    signal: AbortSignal,
  ) {
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(length) ||
      length < 1 ||
      length > 1024 * 1024
    )
      throw new Error("Invalid attachment range.");
    const saved = await this.prepare(fileId, tempDir, signal);
    const file = await open(saved.path, "r");
    try {
      const buffer = Buffer.alloc(
        Math.min(length, Math.max(0, (saved.file.size ?? 0) - offset)),
      );
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      return { base64: buffer.subarray(0, bytesRead).toString("base64") };
    } finally {
      await file.close();
    }
  }
}
