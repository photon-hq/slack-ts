import { describe, expect, it } from "bun:test";
import type { SubscribeEventsResponse } from "../../src/generated/photon/slack/v1/message_service";
import { mapEvent, mapSendParams } from "../../src/transport/mapper";

function asProto(
  obj: Partial<SubscribeEventsResponse>
): SubscribeEventsResponse {
  return obj as SubscribeEventsResponse;
}

describe("mapSendParams", () => {
  it("maps text string → TextContent", () => {
    const r = mapSendParams({ channel: "C1", text: "hi" });
    expect(r.channel).toBe("C1");
    expect(r.text).toEqual({ body: "hi" });
    expect(r.blocks).toBeUndefined();
  });

  it("maps text object → TextContent", () => {
    const r = mapSendParams({ channel: "C1", text: { body: "hi" } });
    expect(r.text).toEqual({ body: "hi" });
  });

  it("maps blocks → BlocksContent with JSON-encoded blocks", () => {
    const r = mapSendParams({
      channel: "C1",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "x" } }],
      fallbackText: "fb",
    });
    expect(r.blocks).toBeDefined();
    expect(
      JSON.parse((r.blocks as NonNullable<typeof r.blocks>).blocksJson)
    ).toEqual([{ type: "section", text: { type: "mrkdwn", text: "x" } }]);
    expect((r.blocks as NonNullable<typeof r.blocks>).fallbackText).toBe("fb");
  });

  it("maps attachments → AttachmentsContent", () => {
    const r = mapSendParams({
      channel: "C1",
      attachments: [{ color: "good", text: "hi" }],
      text: "ft",
    });
    expect(r.attachments).toBeDefined();
    expect(
      JSON.parse(
        (r.attachments as NonNullable<typeof r.attachments>).attachmentsJson
      )
    ).toEqual([{ color: "good", text: "hi" }]);
    expect((r.attachments as NonNullable<typeof r.attachments>).text).toBe(
      "ft"
    );
  });

  it("maps reaction → ReactionContent", () => {
    const r = mapSendParams({
      channel: "C1",
      reaction: { emoji: "thumbsup", itemTs: "111", itemChannel: "C2" },
    });
    expect(r.reaction).toEqual({
      emoji: "thumbsup",
      itemTs: "111",
      itemChannel: "C2",
    });
  });

  it("propagates threadTs and replyBroadcast", () => {
    const r = mapSendParams({
      channel: "C1",
      text: "reply",
      threadTs: "999",
      replyBroadcast: true,
    });
    expect(r.threadTs).toBe("999");
    expect(r.replyBroadcast).toBe(true);
  });
});

describe("mapEvent", () => {
  it("maps message variant", () => {
    const r = mapEvent(
      asProto({
        cursor: { opaque: "abc" },
        message: {
          channel: "C1",
          user: "U1",
          text: "hi",
          ts: "111",
          files: [],
        },
      }),
      "T1"
    );
    expect(r).toEqual({
      type: "message",
      cursor: "abc",
      teamId: "T1",
      message: {
        channel: "C1",
        user: "U1",
        text: "hi",
        ts: "111",
        threadTs: undefined,
        subtype: undefined,
        files: [],
      },
    });
  });

  it("maps reaction variant", () => {
    const r = mapEvent(
      asProto({
        cursor: { opaque: "abc" },
        reaction: {
          user: "U1",
          itemChannel: "C1",
          itemTs: "111",
          name: "thumbsup",
          removed: false,
        },
      }),
      "T1"
    );
    expect(r?.type).toBe("reaction");
  });

  it("maps mention variant", () => {
    const r = mapEvent(
      asProto({
        cursor: { opaque: "abc" },
        mention: { channel: "C1", user: "U1", text: "<@bot>", ts: "111" },
      }),
      "T1"
    );
    expect(r?.type).toBe("mention");
  });

  it("parses interactive raw_payload_json", () => {
    const payload = { action: { value: "yes" } };
    const r = mapEvent(
      asProto({
        cursor: { opaque: "abc" },
        interactive: {
          type: "block_actions",
          user: "U1",
          rawPayloadJson: JSON.stringify(payload),
        },
      }),
      "T1"
    );
    expect(r?.type).toBe("interactive");
    if (r?.type === "interactive") {
      expect(r.interactive.rawPayload).toEqual(payload);
      expect(r.interactive.rawPayloadJson).toBe(JSON.stringify(payload));
    }
  });

  it("returns null for heartbeat", () => {
    const r = mapEvent(
      asProto({ cursor: { opaque: "" }, heartbeat: { at: new Date() } }),
      "T1"
    );
    expect(r).toBeNull();
  });

  it("returns null for unknown payload", () => {
    const r = mapEvent(asProto({ cursor: { opaque: "" } }), "T1");
    expect(r).toBeNull();
  });

  it("stamps teamId on every event", () => {
    const r = mapEvent(
      asProto({
        cursor: { opaque: "abc" },
        message: { channel: "C1", user: "U1", text: "hi", ts: "1", files: [] },
      }),
      "T-TEAM"
    );
    expect(r?.teamId).toBe("T-TEAM");
  });
});
