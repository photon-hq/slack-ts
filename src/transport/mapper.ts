/**
 * Maps between proto generated types and SDK public types.
 *
 * Proto imports are prefixed with `Proto` to distinguish from the SDK types
 * that share similar names.
 */

import type {
  AppMention as ProtoAppMention,
  File as ProtoFile,
  InboundMessage as ProtoInboundMessage,
  InteractiveCallback as ProtoInteractiveCallback,
  Reaction as ProtoReaction,
  SlashCommand as ProtoSlashCommand,
} from "../generated/photon/slack/v1/common";
import type {
  SendMessageRequest as ProtoSendMessageRequest,
  SubscribeEventsResponse as ProtoSubscribeEventsResponse,
} from "../generated/photon/slack/v1/message_service";
import type {
  AppMentionEvent,
  InboundMessage,
  InteractiveCallbackEvent,
  ReactionEvent,
  SlackEvent,
  SlackFile,
  SlashCommandEvent,
} from "../types/events";
import type { SendMessageParams } from "../types/messages";

// ---------------------------------------------------------------------------
// Outbound: SendMessageParams → proto
// ---------------------------------------------------------------------------

export function mapSendParams(
  params: SendMessageParams
): ProtoSendMessageRequest {
  const threadTs = params.threadTs;
  const replyBroadcast = params.replyBroadcast;

  if ("reaction" in params) {
    return {
      channel: params.channel,
      reaction: {
        itemTs: params.reaction.itemTs,
        itemChannel: params.reaction.itemChannel,
        emoji: params.reaction.emoji,
      },
      threadTs,
      replyBroadcast,
    };
  }

  if ("blocks" in params) {
    return {
      channel: params.channel,
      blocks: {
        blocksJson: JSON.stringify(params.blocks),
        fallbackText: params.fallbackText ?? "",
      },
      threadTs,
      replyBroadcast,
    };
  }

  if ("attachments" in params) {
    return {
      channel: params.channel,
      attachments: {
        attachmentsJson: JSON.stringify(params.attachments),
        text: params.text ?? "",
      },
      threadTs,
      replyBroadcast,
    };
  }

  // Text variant — checked last because `attachments` variant also has `text`.
  const text = params.text;
  const body = typeof text === "string" ? text : text.body;
  return {
    channel: params.channel,
    text: { body },
    threadTs,
    replyBroadcast,
  };
}

// ---------------------------------------------------------------------------
// Inbound: proto event → SlackEvent
// ---------------------------------------------------------------------------

/**
 * Returns `null` for heartbeats and any unrecognized payload — callers
 * silently drop those.
 */
export function mapEvent(
  proto: ProtoSubscribeEventsResponse,
  teamId: string
): SlackEvent | null {
  const cursor = proto.cursor?.opaque ?? "";

  if (proto.message) {
    return {
      type: "message",
      cursor,
      teamId,
      message: mapInboundMessage(proto.message),
    };
  }

  if (proto.reaction) {
    return {
      type: "reaction",
      cursor,
      teamId,
      reaction: mapReaction(proto.reaction),
    };
  }

  if (proto.mention) {
    return {
      type: "mention",
      cursor,
      teamId,
      mention: mapMention(proto.mention),
    };
  }

  if (proto.interactive) {
    return {
      type: "interactive",
      cursor,
      teamId,
      interactive: mapInteractive(proto.interactive),
    };
  }

  if (proto.command) {
    return {
      type: "command",
      cursor,
      teamId,
      command: mapCommand(proto.command),
    };
  }

  // heartbeat or unknown — drop.
  return null;
}

function mapInboundMessage(proto: ProtoInboundMessage): InboundMessage {
  return {
    channel: proto.channel,
    user: proto.user,
    text: proto.text,
    ts: proto.ts,
    threadTs: proto.threadTs,
    subtype: proto.subtype,
    files: proto.files.map(mapFile),
  };
}

function mapReaction(proto: ProtoReaction): ReactionEvent {
  return {
    user: proto.user,
    itemChannel: proto.itemChannel,
    itemTs: proto.itemTs,
    name: proto.name,
    removed: proto.removed,
  };
}

function mapMention(proto: ProtoAppMention): AppMentionEvent {
  return {
    channel: proto.channel,
    user: proto.user,
    text: proto.text,
    ts: proto.ts,
  };
}

function mapInteractive(
  proto: ProtoInteractiveCallback
): InteractiveCallbackEvent {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(proto.rawPayloadJson);
  } catch {
    parsed = null;
  }
  return {
    type: proto.type,
    user: proto.user,
    rawPayloadJson: proto.rawPayloadJson,
    rawPayload: parsed,
  };
}

function mapCommand(proto: ProtoSlashCommand): SlashCommandEvent {
  return {
    command: proto.command,
    text: proto.text,
    user: proto.user,
    channel: proto.channel,
    responseUrl: proto.responseUrl,
    triggerId: proto.triggerId,
  };
}

export function mapFile(proto: ProtoFile): SlackFile {
  return {
    id: proto.id,
    name: proto.name,
    mimeType: proto.mimetype,
    size: Number(proto.size),
    urlPrivate: proto.urlPrivate,
  };
}
