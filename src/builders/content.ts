/**
 * Content builders — small helpers that return objects compatible with the
 * content variants of `SendMessageParams`. They compose with `{ channel, ... }`
 * at the call site:
 *
 *   await client.team(t).messages.send({ channel: "C123", ...text("hi") });
 *   await client.team(t).messages.send({ channel: "C123", ...blocks([...]) });
 *
 * JSON serialization for blocks/attachments happens inside the transport
 * mapper, not here — builders hand plain arrays through.
 */

export function text(body: string): { readonly text: string } {
  return { text: body };
}

export function blocks(
  blocks: readonly unknown[],
  fallbackText?: string
): { readonly blocks: readonly unknown[]; readonly fallbackText?: string } {
  return { blocks, fallbackText };
}

export function attachments(
  attachments: readonly unknown[],
  text?: string
): { readonly attachments: readonly unknown[]; readonly text?: string } {
  return { attachments, text };
}

export function reaction(
  emoji: string,
  item: { readonly ts: string; readonly channel: string }
): {
  readonly reaction: {
    readonly emoji: string;
    readonly itemTs: string;
    readonly itemChannel: string;
  };
} {
  return {
    reaction: { emoji, itemTs: item.ts, itemChannel: item.channel },
  };
}
