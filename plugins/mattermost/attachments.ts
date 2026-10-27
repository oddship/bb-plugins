import type { Attachment } from "./contract";
export function attachmentUrl(
  pluginId: string,
  hostId: string,
  fileId: string,
  download = false,
) {
  return (
    "/api/v1/plugins/" +
    encodeURIComponent(pluginId) +
    "/http/attachment?" +
    new URLSearchParams({
      hostId,
      fileId,
      ...(download ? { download: "1" } : {}),
    }).toString()
  );
}
export function attachmentKind(
  file: Attachment,
): "image" | "video" | "audio" | "document" | "file" {
  const mime = (file.mime_type ?? "").split(";")[0].toLowerCase();
  const extension = (
    file.extension ||
    file.name.split(".").at(-1) ||
    ""
  ).toLowerCase();
  if (
    /^image\/(png|jpeg|gif|webp|avif)$/.test(mime) ||
    (!mime && ["png", "jpg", "jpeg", "gif", "webp", "avif"].includes(extension))
  )
    return "image";
  if (/^video\/(mp4|webm|ogg)$/.test(mime)) return "video";
  if (/^audio\/(mpeg|mp4|ogg|wav|webm|x-wav)$/.test(mime)) return "audio";
  if (
    /^(application\/(pdf|json)|text\/(plain|csv|markdown))$/.test(mime) ||
    (!mime && ["pdf", "txt", "csv", "md", "json", "log"].includes(extension))
  )
    return "document";
  return "file";
}
export function normalizeMarkdown(
  content: string,
  files: Attachment[],
  pluginId: string,
  hostId: string,
) {
  // Work messages must not invoke BB app/code-fence renderers or directives.
  let fence: { character: string; length: number } | null = null;
  content = content
    .split("\n")
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})([^\s]*)/.exec(line);
      if (fence) {
        if (
          marker &&
          marker[1][0] === fence.character &&
          marker[1].length >= fence.length &&
          !line.slice(marker[0].length).trim() &&
          !marker[2]
        )
          fence = null;
        return line;
      }
      if (marker) {
        fence = { character: marker[1][0], length: marker[1].length };
        if (["ui", "app", "inline-vis"].includes(marker[2].toLowerCase()))
          return line.replace(marker[2], "text");
        return line;
      }
      if (/^\s*::[a-z][\w-]*\{/.test(line)) {
        const runs = line.match(/`+/g) ?? [];
        const delimiter = "`".repeat(
          Math.max(0, ...runs.map((run) => run.length)) + 1,
        );
        return delimiter + " " + line + " " + delimiter;
      }
      return line;
    })
    .join("\n");
  if (!hostId) return content;
  const ids = new Set(files.map((f) => f.id));
  return content.replace(
    /(!\[[^\]\n]*\]\()((?:https?:\/\/[^/\s)]+)?\/api\/v4\/files\/([a-z0-9]{26})(?:\/(?:preview|thumbnail))?)(\))/g,
    (match, start, _url, id, end) =>
      ids.has(id) ? start + attachmentUrl(pluginId, hostId, id) + end : match,
  );
}
export function fileSize(bytes: number | undefined) {
  if (bytes === undefined) return "";
  return bytes < 1024
    ? bytes + " B"
    : bytes < 1024 * 1024
      ? (bytes / 1024).toFixed(1) + " KiB"
      : (bytes / (1024 * 1024)).toFixed(1) + " MiB";
}
