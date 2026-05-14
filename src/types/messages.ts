/**
 * Input shape for `messages.send`.
 *
 * The content variant is a discriminated union — exactly one of `text`,
 * `blocks`, `attachments`, or `reaction` should be present. TypeScript will
 * enforce this at the call site.
 *
 * The reaction variant ignores the top-level `channel`/`threadTs` (Slack's
 * `reactions.add` takes `item_channel`/`item_ts` instead, carried inside
 * `reaction`).
 */

interface SendMessageBase {
  /** Slack channel id (`C012ABCDE`) or DM id (`D012...`) or user id (`U012...`). */
  readonly channel: string;
  /** When `true`, also broadcast the thread reply to the channel. */
  readonly replyBroadcast?: boolean;
  /** Reply to a thread by passing the parent message's `ts`. */
  readonly threadTs?: string;
}

export type SendMessageParams = SendMessageBase &
  (
    | { readonly text: string | { readonly body: string } }
    | { readonly blocks: readonly unknown[]; readonly fallbackText?: string }
    | { readonly attachments: readonly unknown[]; readonly text?: string }
    | {
        readonly reaction: {
          readonly emoji: string;
          readonly itemTs: string;
          readonly itemChannel: string;
        };
      }
  );

export interface SendMessageResult {
  readonly channel: string;
  /** The Slack `ts` of the posted message (or empty string for `reactions.add`). */
  readonly ts: string;
}
