/**
 * Tiny Block Kit JSON helpers — minimal coverage for v0.1.
 *
 * Returns `unknown` because Slack's Block Kit schema is large and we don't
 * want to ship our own copy. Callers can drop in arbitrary JSON for blocks
 * we don't have helpers for.
 */

export function section(
  text: string,
  opts?: { readonly accessory?: unknown; readonly fields?: readonly string[] }
): unknown {
  const block: Record<string, unknown> = {
    type: "section",
    text: { type: "mrkdwn", text },
  };
  if (opts?.accessory) {
    block.accessory = opts.accessory;
  }
  if (opts?.fields) {
    block.fields = opts.fields.map((f) => ({ type: "mrkdwn", text: f }));
  }
  return block;
}

export function divider(): unknown {
  return { type: "divider" };
}

export function header(text: string): unknown {
  return { type: "header", text: { type: "plain_text", text } };
}

export function context(...elements: readonly unknown[]): unknown {
  return { type: "context", elements };
}

export function actions(...elements: readonly unknown[]): unknown {
  return { type: "actions", elements };
}

export function button(
  text: string,
  opts: {
    readonly actionId: string;
    readonly value?: string;
    readonly url?: string;
    readonly style?: "primary" | "danger";
  }
): unknown {
  const element: Record<string, unknown> = {
    type: "button",
    text: { type: "plain_text", text },
    action_id: opts.actionId,
  };
  if (opts.value !== undefined) {
    element.value = opts.value;
  }
  if (opts.url !== undefined) {
    element.url = opts.url;
  }
  if (opts.style !== undefined) {
    element.style = opts.style;
  }
  return element;
}

export function image(
  imageUrl: string,
  altText: string,
  opts?: { readonly title?: string; readonly blockId?: string }
): unknown {
  const block: Record<string, unknown> = {
    type: "image",
    image_url: imageUrl,
    alt_text: altText,
  };
  if (opts?.title !== undefined) {
    block.title = { type: "plain_text", text: opts.title };
  }
  if (opts?.blockId !== undefined) {
    block.block_id = opts.blockId;
  }
  return block;
}

export function input(
  label: string,
  element: unknown,
  opts?: {
    readonly hint?: string;
    readonly optional?: boolean;
    readonly dispatchAction?: boolean;
    readonly blockId?: string;
  }
): unknown {
  const block: Record<string, unknown> = {
    type: "input",
    label: { type: "plain_text", text: label },
    element,
  };
  if (opts?.hint !== undefined) {
    block.hint = { type: "plain_text", text: opts.hint };
  }
  if (opts?.optional !== undefined) {
    block.optional = opts.optional;
  }
  if (opts?.dispatchAction !== undefined) {
    block.dispatch_action = opts.dispatchAction;
  }
  if (opts?.blockId !== undefined) {
    block.block_id = opts.blockId;
  }
  return block;
}

export function video(opts: {
  readonly videoUrl: string;
  readonly thumbnailUrl: string;
  readonly altText: string;
  readonly title: string;
  readonly authorName?: string;
  readonly providerName?: string;
  readonly providerIconUrl?: string;
  readonly titleUrl?: string;
  readonly description?: string;
  readonly blockId?: string;
}): unknown {
  const block: Record<string, unknown> = {
    type: "video",
    video_url: opts.videoUrl,
    thumbnail_url: opts.thumbnailUrl,
    alt_text: opts.altText,
    title: { type: "plain_text", text: opts.title },
  };
  if (opts.authorName !== undefined) {
    block.author_name = opts.authorName;
  }
  if (opts.providerName !== undefined) {
    block.provider_name = opts.providerName;
  }
  if (opts.providerIconUrl !== undefined) {
    block.provider_icon_url = opts.providerIconUrl;
  }
  if (opts.titleUrl !== undefined) {
    block.title_url = opts.titleUrl;
  }
  if (opts.description !== undefined) {
    block.description = { type: "plain_text", text: opts.description };
  }
  if (opts.blockId !== undefined) {
    block.block_id = opts.blockId;
  }
  return block;
}

/**
 * Wraps the given rich-text elements (e.g. `rich_text_section`,
 * `rich_text_list`, `rich_text_quote`, `rich_text_preformatted`) into a
 * `rich_text` block. Element shapes are not validated — pass raw JSON.
 */
export function richText(...elements: readonly unknown[]): unknown {
  return { type: "rich_text", elements };
}
