// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { AttachmentView } from "./attachment-ui";
afterEach(cleanup);
const file = {
  id: "a".repeat(26),
  name: "chart.png",
  mime_type: "image/png",
  size: 19017,
};
test("an authenticated image preview retries cleanly and offers native downloads", async () => {
  const slot = renderSlot(
    { component: AttachmentView },
    { file },
    { pluginId: "mattermost", settings: { hostId: "host_test" } },
  );
  const img = slot.getByAltText("chart.png") as HTMLImageElement;
  expect(img.src).toContain("hostId=host_test");
  fireEvent.error(img);
  await slot.findByRole("alert");
  fireEvent.click(slot.getByText("Retry preview"));
  expect((slot.getByAltText("chart.png") as HTMLImageElement).src).toContain(
    "retry=1",
  );
  expect(slot.getByText("Download").getAttribute("href")).toContain(
    "download=1",
  );
  slot.lifecycle.unmount();
});
test("unsafe file types offer downloads without embedding HTML or SVG", () => {
  const slot = renderSlot(
    { component: AttachmentView },
    { file: { ...file, name: "test.html", mime_type: "text/html" } },
    { settings: { hostId: "host_test" } },
  );
  expect(slot.queryByRole("img")).toBeNull();
  expect(slot.queryByTitle("Preview test.html")).toBeNull();
  expect(slot.getByText("Download this file to open it.")).toBeTruthy();
  slot.lifecycle.unmount();
});
test("documents preview only after the user requests it", () => {
  const slot = renderSlot(
    { component: AttachmentView },
    { file: { ...file, name: "notes.pdf", mime_type: "application/pdf" } },
    { settings: { hostId: "host_test" } },
  );
  expect(slot.queryByTitle("Preview notes.pdf")).toBeNull();
  fireEvent.click(slot.getByText("Preview document"));
  expect(slot.getByTitle("Preview notes.pdf").getAttribute("sandbox")).toBe("");
  slot.lifecycle.unmount();
});
