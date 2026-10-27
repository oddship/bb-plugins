import { expect, test } from "vitest";
import { commandArgs } from "./mm";
import { overviewSchema, channelSchema } from "./contract";
test("only read commands and valid IDs reach execFile", () => {
  for (const kind of ["login", "logout", "send", "--debug"])
    expect(() => commandArgs({ kind })).toThrow();
  for (const target of ["--help", "; touch /tmp/oops", "bad"])
    expect(() => commandArgs({ kind: "messages", target })).toThrow();
  expect(() =>
    commandArgs({ kind: "mentions", since: "1d", debug: true }),
  ).toThrow();
});
test("unread preserves IDs needed to open channel and overview allows no active channels", () => {
  expect(
    channelSchema.parse({
      channel_id: "a".repeat(26),
      channel: "Work",
      unread: 3,
    }).channel_id,
  ).toBe("a".repeat(26));
  expect(
    overviewSchema.parse({ since: "1d", mentions: [], unread: [] })
      .active_channels,
  ).toEqual([]);
});
test("argument bounds are applied to messages and mentions", () => {
  expect(commandArgs({ kind: "messages", target: "a".repeat(26) })).toEqual([
    "messages",
    "a".repeat(26),
    "--limit",
    "100",
  ]);
  expect(commandArgs({ kind: "mentions" })).toEqual([
    "mentions",
    "--since",
    "1d",
    "--limit",
    "100",
  ]);
});
test("search is bounded and cannot be interpreted as a CLI flag", () => {
  expect(commandArgs({ kind: "search", query: "in:work order exits" })).toEqual(
    ["search", "in:work order exits", "--limit", "50"],
  );
  expect(() => commandArgs({ kind: "search", query: "--debug" })).toThrow();
  expect(() =>
    commandArgs({ kind: "search", query: "x".repeat(301) }),
  ).toThrow();
});
test("thread expansion is bounded and uses a separate validated limit", () => {
  expect(
    commandArgs({ kind: "thread", target: "a".repeat(26), limit: 500 }),
  ).toEqual(["thread", "a".repeat(26), "--limit", "500"]);
  expect(() =>
    commandArgs({ kind: "thread", target: "a".repeat(26), limit: 0 }),
  ).toThrow();
  expect(() =>
    commandArgs({ kind: "thread", target: "a".repeat(26), limit: 10000 }),
  ).toThrow();
});
