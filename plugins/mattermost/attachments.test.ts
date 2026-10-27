import { expect, test } from "vitest";
import {
  attachmentKind,
  attachmentUrl,
  normalizeMarkdown,
} from "./attachments";
const file = { id: "a".repeat(26), name: "image.png" };
test("attachment relay URLs use BB host scope, not work credentials", () => {
  const url = attachmentUrl("mattermost", "host_work", file.id, true);
  expect(url).toContain("/plugins/mattermost/http/attachment?");
  expect(new URL(url, "https://bb.example").searchParams.get("hostId")).toBe(
    "host_work",
  );
  expect(url).not.toContain("token");
});
test("only known raster files and supported media/document types get previews", () => {
  expect(attachmentKind(file)).toBe("image");
  expect(
    attachmentKind({ ...file, name: "attack.svg", mime_type: "image/svg+xml" }),
  ).toBe("file");
  expect(
    attachmentKind({ ...file, name: "attack.html", mime_type: "text/html" }),
  ).toBe("file");
  expect(
    attachmentKind({
      ...file,
      name: "report.pdf",
      mime_type: "application/pdf",
    }),
  ).toBe("document");
  expect(
    attachmentKind({ ...file, name: "clip.mp4", mime_type: "video/mp4" }),
  ).toBe("video");
});
test("Mattermost embedded images for attached files use the authenticated relay", () => {
  const content =
    "![chart](/api/v4/files/" + file.id + "/preview)\n\n**Bold** and `code`";
  expect(
    normalizeMarkdown(content, [file], "mattermost", "host_work"),
  ).toContain(attachmentUrl("mattermost", "host_work", file.id));
  expect(normalizeMarkdown(content, [], "mattermost", "host_work")).toBe(
    content,
  );
  expect(
    normalizeMarkdown(
      "![x](https://example.com/image.png)",
      [file],
      "mattermost",
      "host_work",
    ),
  ).toBe("![x](https://example.com/image.png)");
});
test("external messages cannot activate BB app fences or file directives", () => {
  const content = [
    "```ui",
    'Image("private.png")',
    "```",
    '::inline-vis{file="report.html"}',
    "```javascript",
    "const x = 1;",
    "```",
  ].join("\n");
  const rendered = normalizeMarkdown(content, [], "mattermost", "host");
  expect(rendered).toContain("```text");
  expect(rendered).not.toContain("```ui");
  expect(rendered).toContain('` ::inline-vis{file="report.html"} `');
  expect(rendered).toContain("```javascript\nconst x = 1;\n```");
});
