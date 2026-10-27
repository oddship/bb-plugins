import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { hostContract } from "./contract";
import { readMm } from "./mm";
import { AttachmentHost } from "./attachment-host";
const attachments = new AttachmentHost();
export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    read: (request, context) => readMm(request, context.signal),
    attachment: async ({ fileId }, context) =>
      (
        await attachments.prepare(
          fileId,
          context.experimental_paths.tempDir,
          context.signal,
        )
      ).file,
    attachmentChunk: ({ fileId, offset, length }, context) =>
      attachments.chunk(
        fileId,
        offset,
        length,
        context.experimental_paths.tempDir,
        context.signal,
      ),
  },
});
