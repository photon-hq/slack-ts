import { describe, expect, it } from "bun:test";
import {
  actions,
  button,
  context,
  divider,
  header,
  image,
  input,
  richText,
  section,
  video,
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

  it("image() with required-only args", () => {
    expect(image("https://example.com/cat.png", "a cat")).toEqual({
      type: "image",
      image_url: "https://example.com/cat.png",
      alt_text: "a cat",
    });
  });

  it("image() with title and block_id", () => {
    expect(
      image("https://example.com/cat.png", "a cat", {
        title: "Cat",
        blockId: "b1",
      })
    ).toEqual({
      type: "image",
      image_url: "https://example.com/cat.png",
      alt_text: "a cat",
      title: { type: "plain_text", text: "Cat" },
      block_id: "b1",
    });
  });

  it("input() with required-only args", () => {
    const element = { type: "plain_text_input", action_id: "name" };
    expect(input("Name", element)).toEqual({
      type: "input",
      label: { type: "plain_text", text: "Name" },
      element,
    });
  });

  it("input() with hint, optional, dispatch_action, block_id", () => {
    const element = { type: "plain_text_input", action_id: "name" };
    expect(
      input("Name", element, {
        hint: "first and last",
        optional: true,
        dispatchAction: true,
        blockId: "b2",
      })
    ).toEqual({
      type: "input",
      label: { type: "plain_text", text: "Name" },
      element,
      hint: { type: "plain_text", text: "first and last" },
      optional: true,
      dispatch_action: true,
      block_id: "b2",
    });
  });

  it("video() with required-only args", () => {
    expect(
      video({
        videoUrl: "https://example.com/v.mp4",
        thumbnailUrl: "https://example.com/t.png",
        altText: "demo",
        title: "Demo",
      })
    ).toEqual({
      type: "video",
      video_url: "https://example.com/v.mp4",
      thumbnail_url: "https://example.com/t.png",
      alt_text: "demo",
      title: { type: "plain_text", text: "Demo" },
    });
  });

  it("video() with all optional fields", () => {
    expect(
      video({
        videoUrl: "https://example.com/v.mp4",
        thumbnailUrl: "https://example.com/t.png",
        altText: "demo",
        title: "Demo",
        authorName: "Acme",
        providerName: "Acme TV",
        providerIconUrl: "https://example.com/icon.png",
        titleUrl: "https://example.com/watch",
        description: "the description",
        blockId: "b3",
      })
    ).toEqual({
      type: "video",
      video_url: "https://example.com/v.mp4",
      thumbnail_url: "https://example.com/t.png",
      alt_text: "demo",
      title: { type: "plain_text", text: "Demo" },
      author_name: "Acme",
      provider_name: "Acme TV",
      provider_icon_url: "https://example.com/icon.png",
      title_url: "https://example.com/watch",
      description: { type: "plain_text", text: "the description" },
      block_id: "b3",
    });
  });

  it("richText() wraps elements", () => {
    const el = {
      type: "rich_text_section",
      elements: [{ type: "text", text: "hi", style: { bold: true } }],
    };
    expect(richText(el)).toEqual({ type: "rich_text", elements: [el] });
  });
});
