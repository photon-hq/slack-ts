import { describe, expect, it } from "bun:test";
import {
  actions,
  button,
  context,
  divider,
  header,
  section,
} from "../../src/builders/blockkit";
import {
  attachments,
  blocks,
  reaction,
  text,
} from "../../src/builders/content";

describe("content builders", () => {
  it("text() returns { text }", () => {
    expect(text("hi")).toEqual({ text: "hi" });
  });

  it("blocks() returns { blocks, fallbackText }", () => {
    const r = blocks([{ type: "divider" }], "fb");
    expect(r.blocks).toEqual([{ type: "divider" }]);
    expect(r.fallbackText).toBe("fb");
  });

  it("attachments() returns { attachments, text }", () => {
    const r = attachments([{ color: "good" }], "alt");
    expect(r.attachments).toEqual([{ color: "good" }]);
    expect(r.text).toBe("alt");
  });

  it("reaction() builds ReactionContent shape", () => {
    const r = reaction("thumbsup", { ts: "1", channel: "C1" });
    expect(r.reaction).toEqual({
      emoji: "thumbsup",
      itemTs: "1",
      itemChannel: "C1",
    });
  });

  it("builders compose with channel via spread", () => {
    const params = { channel: "C1", ...text("hello") };
    expect(params).toEqual({ channel: "C1", text: "hello" });
  });
});

describe("Block Kit builders", () => {
  it("section() emits section with mrkdwn", () => {
    expect(section("hi")).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "hi" },
    });
  });

  it("section() with fields", () => {
    expect(section("hi", { fields: ["a", "b"] })).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "hi" },
      fields: [
        { type: "mrkdwn", text: "a" },
        { type: "mrkdwn", text: "b" },
      ],
    });
  });

  it("divider()", () => {
    expect(divider()).toEqual({ type: "divider" });
  });

  it("header()", () => {
    expect(header("Title")).toEqual({
      type: "header",
      text: { type: "plain_text", text: "Title" },
    });
  });

  it("context() with elements", () => {
    expect(context({ type: "plain_text", text: "hi" })).toEqual({
      type: "context",
      elements: [{ type: "plain_text", text: "hi" }],
    });
  });

  it("actions() with elements", () => {
    expect(actions({ type: "button" })).toEqual({
      type: "actions",
      elements: [{ type: "button" }],
    });
  });

  it("button() with required + optional opts", () => {
    expect(
      button("Yes", { actionId: "yes", value: "1", style: "primary" })
    ).toEqual({
      type: "button",
      text: { type: "plain_text", text: "Yes" },
      action_id: "yes",
      value: "1",
      style: "primary",
    });
  });
});
