/**
 * Public event types yielded by `EventsResource.subscribe` and
 * `EventsResource.fetchMissed`.
 *
 * Each variant carries `cursor` (opaque) and `teamId` (stamped by the resource,
 * since it is bound to a single team but the proto does not carry it). The
 * `teamId` is what lets a downstream bridge (e.g. spectrum-ts) route events
 * in a merged cross-team stream.
 */

// ---------------------------------------------------------------------------
// Inbound message bodies
// ---------------------------------------------------------------------------

export interface SlackFile {
  readonly id: string;
  readonly mimeType: string;
  readonly name: string;
  readonly size: number;
  readonly urlPrivate: string;
}

export interface InboundMessage {
  readonly channel: string;
  readonly files: readonly SlackFile[];
  /** `true` when `user` is this installation's bot user id (server-stamped). */
  readonly isFromMe: boolean;
  readonly subtype?: string;
  readonly text: string;
  readonly threadTs?: string;
  readonly ts: string;
  readonly user: string;
}

export interface ReactionEvent {
  /** `true` when the reactor is this installation's bot user id (server-stamped). */
  readonly isFromMe: boolean;
  readonly itemChannel: string;
  readonly itemTs: string;
  /** The Slack reaction name (no surrounding colons). */
  readonly name: string;
  /** `true` for `reaction_removed`, `false` for `reaction_added`. */
  readonly removed: boolean;
  readonly user: string;
}

export interface AppMentionEvent {
  readonly channel: string;
  /** `true` when `user` is this installation's bot user id (server-stamped). */
  readonly isFromMe: boolean;
  readonly text: string;
  readonly ts: string;
  readonly user: string;
}

export interface InteractiveCallbackEvent {
  /**
   * `true` when the actor is this installation's bot user id. Almost always
   * `false` — Slack doesn't deliver bot-originated interactives — present
   * for symmetry with other inbound events.
   */
  readonly isFromMe: boolean;
  /** `rawPayloadJson` already parsed for convenience. */
  readonly rawPayload: unknown;
  /** Raw JSON payload as Slack delivered it. */
  readonly rawPayloadJson: string;
  /** e.g. `block_actions`, `view_submission`, `shortcut`, `message_action`. */
  readonly type: string;
  readonly user: string;
}

export interface SlashCommandEvent {
  readonly channel: string;
  readonly command: string;
  /**
   * `true` when the invoker is this installation's bot user id. Almost
   * always `false` — slash commands are user-driven — present for symmetry.
   */
  readonly isFromMe: boolean;
  readonly responseUrl: string;
  readonly text: string;
  readonly triggerId: string;
  readonly user: string;
}

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export type SlackEvent =
  | {
      readonly type: "message";
      readonly cursor: string;
      readonly teamId: string;
      readonly message: InboundMessage;
    }
  | {
      readonly type: "reaction";
      readonly cursor: string;
      readonly teamId: string;
      readonly reaction: ReactionEvent;
    }
  | {
      readonly type: "mention";
      readonly cursor: string;
      readonly teamId: string;
      readonly mention: AppMentionEvent;
    }
  | {
      readonly type: "interactive";
      readonly cursor: string;
      readonly teamId: string;
      readonly interactive: InteractiveCallbackEvent;
    }
  | {
      readonly type: "command";
      readonly cursor: string;
      readonly teamId: string;
      readonly command: SlashCommandEvent;
    };
