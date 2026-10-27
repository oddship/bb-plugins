import { useState } from "react";
import {
  useSettings,
  UrlLink,
  experimental_usePluginId,
  experimental_saveFile,
  experimental_ImageLightbox as ImageLightbox,
} from "@get-bb/plugin-sdk/app";
import type { Attachment } from "./contract";
import { attachmentUrl, attachmentKind, fileSize } from "./attachments";
import { Button } from "./components/ui/button";

export function AttachmentView({
  file,
  postId,
}: {
  file: Attachment;
  postId?: string;
}) {
  const { values } = useSettings(),
    pluginId = experimental_usePluginId();
  const hostId = String(values?.hostId ?? "");
  const serverUrl = String(values?.serverUrl ?? "").replace(/\/$/, "");
  const tooLarge = (file.size ?? 0) > 64 * 1024 * 1024;
  const [failed, setFailed] = useState(false),
    [retry, setRetry] = useState(0);
  const [preview, setPreview] = useState(false),
    [zoom, setZoom] = useState(false);
  const [status, setStatus] = useState("");
  const kind = attachmentKind(file),
    name = file.name || "Attachment";
  const base = attachmentUrl(pluginId, hostId, file.id);
  const url = base + (retry ? "&retry=" + retry : "");
  const downloadUrl = attachmentUrl(pluginId, hostId, file.id, true);
  return (
    <section
      className="space-y-2 overflow-hidden rounded-md border border-border p-2"
      aria-label={"Attachment: " + name}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="min-w-0 break-words font-medium">
          {name}
          {file.size !== undefined ? (
            <span className="ml-2 font-normal text-muted-foreground">
              {fileSize(file.size)}
            </span>
          ) : null}
        </span>
        {hostId && !tooLarge ? (
          <a
            className="shrink-0 underline"
            href={downloadUrl}
            download={name}
            onClick={(event) => {
              event.preventDefault();
              void experimental_saveFile({
                fileName: name,
                url: downloadUrl,
              }).then((result) =>
                setStatus(
                  result === "started"
                    ? "Download started."
                    : "Download could not start. Try again.",
                ),
              );
            }}
          >
            Download
          </a>
        ) : null}
      </div>
      {serverUrl && postId ? (
        <UrlLink
          className="text-xs underline"
          href={serverUrl + "/_redirect/pl/" + postId}
        >
          Open original message
        </UrlLink>
      ) : null}
      {tooLarge ? (
        <p className="text-xs text-muted-foreground">
          Open attachments over 64 MiB in the original Mattermost message.
        </p>
      ) : !hostId ? (
        <p className="text-xs text-muted-foreground">
          Connecting to the Mattermost host…
        </p>
      ) : failed ? (
        <div role="alert" className="space-y-1 text-xs text-muted-foreground">
          <p>Preview could not load. Retry or download the attachment.</p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setFailed(false);
              setRetry((n) => n + 1);
            }}
          >
            Retry preview
          </Button>
        </div>
      ) : kind === "image" ? (
        <>
          <button
            type="button"
            className="block w-full cursor-zoom-in"
            aria-label={"Enlarge " + name}
            onClick={() => setZoom(true)}
          >
            <img
              src={url}
              loading="lazy"
              alt={name}
              className="max-h-80 w-full rounded object-contain"
              onError={() => setFailed(true)}
            />
          </button>
          <ImageLightbox
            imageSrc={url}
            imageAlt={name}
            title={name}
            isOpen={zoom}
            onClose={() => setZoom(false)}
          />
        </>
      ) : kind === "video" ? (
        <video
          controls
          preload="none"
          src={url}
          className="max-h-80 w-full rounded"
          onError={() => setFailed(true)}
          aria-label={name}
        />
      ) : kind === "audio" ? (
        <audio
          controls
          preload="none"
          src={url}
          className="w-full"
          onError={() => setFailed(true)}
          aria-label={name}
        />
      ) : kind === "document" ? (
        <>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPreview((v) => !v)}
          >
            {preview ? "Hide preview" : "Preview document"}
          </Button>
          {preview ? (
            <iframe
              src={url}
              sandbox=""
              title={"Preview " + name}
              className="h-80 w-full rounded border border-border"
              onError={() => setFailed(true)}
            />
          ) : null}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          Download this file to open it.
        </p>
      )}
      {status ? (
        <p role="status" className="text-xs text-muted-foreground">
          {status}
        </p>
      ) : null}
    </section>
  );
}
export function AttachmentList({
  files,
  postId,
}: {
  files: Attachment[];
  postId?: string;
}) {
  return (
    <div className="space-y-2">
      {files.map((file) => (
        <AttachmentView key={file.id} file={file} postId={postId} />
      ))}
    </div>
  );
}
