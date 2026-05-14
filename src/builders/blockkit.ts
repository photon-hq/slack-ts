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
