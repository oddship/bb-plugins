import {
  Markdown,
  useSettings,
  experimental_usePluginId,
} from "@get-bb/plugin-sdk/app";
import type { Attachment } from "./contract";
import { normalizeMarkdown } from "./attachments";
import "./message-body.css";
export function MessageBody({
  content,
  files = [],
}: {
  content: string;
  files?: Attachment[];
}) {
  const pluginId = experimental_usePluginId();
  const { values } = useSettings();
  return (
    <div className="mattermost-markdown break-words text-sm">
      <Markdown
        content={normalizeMarkdown(
          content,
          files,
          pluginId,
          String(values?.hostId ?? ""),
        )}
      />
    </div>
  );
}
