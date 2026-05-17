#!/usr/bin/env bun

/**
 * End-to-end exerciser for the entire @photon-ai/slack public surface.
 *
 * Walks through every feature re-exported from `src/index.ts`:
 *   - createClient with staticTokens
 *   - teams() discovery, team() per-team caching
 *   - messages.send for all four content variants
 *   - thread replies + replyBroadcast
 *   - messages.markRead
 *   - AbortSignal cancellation via RequestOptions
 *   - files.upload (string / Uint8Array / Buffer) + files.getUrl
 *   - error subclass taxonomy via instanceof
 *   - events.subscribe + TypedEventStream operators (.take / .filter / .map / .on)
 *   - reconnect options + custom CursorStore
 *   - events.fetchMissed
 *   - await using lifecycle
 *
 * Usage:
 *   SPECTRUM_SLACK_ENDPOINT=localhost:50051 \
 *   bun run scripts/example.ts
 *
 * The script prompts for teamId, botUserId, JWT, and a test channel
 * id (`C…`) where the bot has been invited. Each section logs what it
 * is about to do and catches its own errors so a single failure does
 * not abort the rest of the smoke test.
 */

import { Buffer } from "node:buffer";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  AuthenticationError,
  actions,
  attachments,
  blocks,
  button,
  ConnectionError,
  type CursorStore,
  context,
  createClient,
  createInMemoryCursorStore,
  divider,
  ErrorCode,
  header,
  NotFoundError,
  PermissionError,
  RateLimitError,
  reaction,
  type SendMessageResult,
  SlackError,
  type SlackEvent,
  section,
  staticTokens,
  text,
  ValidationError,
} from "../src/index";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STREAM_TIMEOUT_MS = 30_000;
const CURSOR_STORE_TIMEOUT_MS = 5000;
const ON_CALLBACK_DELAY_MS = 1000;
const RECONNECT_INITIAL_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 5000;
const RECONNECT_MAX_ATTEMPTS = 3;
const RECONNECT_MULTIPLIER = 2;
const DEFAULT_TIMEOUT_MS = 10_000;
const FETCH_MISSED_LIMIT = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const log = (msg: string): void => {
  console.log(msg);
};

const logError = (where: string, err: unknown): void => {
  if (err instanceof Error) {
    console.error(`[${where}] ${err.constructor.name}: ${err.message}`);
  } else {
    console.error(`[${where}] non-Error thrown: ${String(err)}`);
  }
};

const runSection = async (
  title: string,
  fn: () => Promise<void>
): Promise<void> => {
  log(`\n=== ${title} ===`);
  try {
    await fn();
  } catch (err) {
    logError(title, err);
  }
};

const formatErrorClass = (err: unknown): string =>
  err instanceof Error ? err.constructor.name : typeof err;

// ---------------------------------------------------------------------------
// Prompt for inputs
// ---------------------------------------------------------------------------

const rl = createInterface({ input: stdin, output: stdout });
const teamId = (await rl.question("teamId (T...): ")).trim();
const botUserId = (await rl.question("botUserId (U...): ")).trim();
const token = (await rl.question("token (eyJ...): ")).trim();
const channel = (await rl.question("channel (C...): ")).trim();
const skipStreamingRaw = (
  await rl.question("skip streaming sections? [y/N]: ")
).trim();
rl.close();

const skipStreaming = skipStreamingRaw.toLowerCase().startsWith("y");

const teamMeta = {
  teamName: teamId,
  botUserId,
  appId: "",
  grantedScopes: [],
};

// ---------------------------------------------------------------------------
// Section 1 — Client construction (staticTokens)
// ---------------------------------------------------------------------------

log("\n=== 1. createClient (staticTokens) ===");
const client = createClient({
  tokenProvider: staticTokens({
    tokens: { [teamId]: token },
    teams: { [teamId]: teamMeta },
  }),
  spectrumSlackEndpoint: process.env.SPECTRUM_SLACK_ENDPOINT,
  timeout: DEFAULT_TIMEOUT_MS,
  retry: true,
});
log("created SlackClient via staticTokens");

// State shared between sections.
let postedTs: string | undefined;

try {
  // -------------------------------------------------------------------------
  // Section 2 — teams() discovery
  // -------------------------------------------------------------------------
  await runSection("2. client.teams()", async () => {
    const teams = await client.teams();
    log(`teams.size=${teams.size}`);
    for (const [id, meta] of teams) {
      log(
        `  ${id} name=${meta.teamName} bot=${meta.botUserId} app=${meta.appId} scopes=[${meta.grantedScopes.join(",")}]`
      );
    }
  });

  // -------------------------------------------------------------------------
  // Section 3 — team() caching
  // -------------------------------------------------------------------------
  await runSection("3. client.team() caching", async () => {
    const a = client.team(teamId);
    const b = client.team(teamId);
    log(`teamId=${a.teamId} cached=${a === b}`);
  });

  const team = client.team(teamId);

  // -------------------------------------------------------------------------
  // Section 4 — messages.send (all four content variants)
  // -------------------------------------------------------------------------
  await runSection("4a. send text (string form)", async () => {
    const result = await team.messages.send({
      channel,
      ...text("hello from example.ts"),
    });
    postedTs = result.ts;
    log(`ok ts=${result.ts} channel=${result.channel}`);
  });

  await runSection("4b. send text (object form)", async () => {
    const result = await team.messages.send({
      channel,
      text: { body: "hello (object form)" },
    });
    log(`ok ts=${result.ts}`);
  });

  await runSection("4c. send blocks (all Block Kit helpers)", async () => {
    const result = await team.messages.send({
      channel,
      ...blocks(
        [
          header("Demo header"),
          section("Hello *world* — section with fields and accessory", {
            fields: ["field A", "field B"],
            accessory: button("Open", {
              actionId: "open",
              url: "https://example.com",
              style: "primary",
            }),
          }),
          divider(),
          context("rendered via context()"),
          actions(
            button("Click me", {
              actionId: "click",
              value: "v",
              style: "danger",
            })
          ),
        ],
        "Fallback text for notifications"
      ),
    });
    log(`ok ts=${result.ts}`);
  });

  await runSection("4d. send attachments", async () => {
    const result = await team.messages.send({
      channel,
      ...attachments(
        [{ color: "#36a64f", text: "attached body" }],
        "Preface text"
      ),
    });
    log(`ok ts=${result.ts}`);
  });

  await runSection("4e. send reaction", async () => {
    if (!postedTs) {
      log("skipped — no prior message ts");
      return;
    }
    const result = await team.messages.send({
      channel,
      ...reaction("thumbsup", { ts: postedTs, channel }),
    });
    log(`ok ts="${result.ts}" channel=${result.channel}`);
  });

  // -------------------------------------------------------------------------
  // Section 5 — Thread reply + replyBroadcast
  // -------------------------------------------------------------------------
  await runSection("5. thread reply + replyBroadcast", async () => {
    if (!postedTs) {
      log("skipped — no prior message ts");
      return;
    }
    const result = await team.messages.send({
      channel,
      threadTs: postedTs,
      replyBroadcast: true,
      ...text("threaded reply, broadcast to channel"),
    });
    log(`ok ts=${result.ts}`);
  });

  // -------------------------------------------------------------------------
  // Section 6 — messages.markRead
  // -------------------------------------------------------------------------
  await runSection("6. messages.markRead", async () => {
    if (!postedTs) {
      log("skipped — no prior message ts");
      return;
    }
    await team.messages.markRead({ channel, ts: postedTs });
    log(`ok marked ts=${postedTs} as read`);
  });

  // -------------------------------------------------------------------------
  // Section 7 — AbortSignal
  // -------------------------------------------------------------------------
  await runSection("7. AbortSignal cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    try {
      const result: SendMessageResult = await team.messages.send(
        { channel, ...text("should never post") },
        { signal: controller.signal }
      );
      log(`unexpected success ts=${result.ts}`);
    } catch (err) {
      log(`caught ${formatErrorClass(err)}: aborted as expected`);
    }
  });

  // -------------------------------------------------------------------------
  // Section 8 — files.upload + files.getUrl
  // -------------------------------------------------------------------------
  await runSection("8a. files.upload (string)", async () => {
    const result = await team.files.upload({
      channel,
      filename: "hello-string.txt",
      mimeType: "text/plain",
      content: "uploaded via string content",
      initialComment: "string upload demo",
      threadTs: postedTs,
    });
    log(
      `ok file id=${result.file.id} name=${result.file.name} size=${result.file.size} mime=${result.file.mimeType}`
    );
    const urlResult = await team.files.getUrl(result.file.id);
    log(`  signed url=${urlResult.url}`);
  });

  await runSection("8b. files.upload (Uint8Array)", async () => {
    const bytes = new TextEncoder().encode("uploaded via Uint8Array content");
    const result = await team.files.upload({
      channel,
      filename: "hello-bytes.txt",
      mimeType: "text/plain",
      content: bytes,
    });
    log(`ok file id=${result.file.id}`);
  });

  await runSection("8c. files.upload (Buffer)", async () => {
    const result = await team.files.upload({
      channel,
      filename: "hello-buffer.txt",
      mimeType: "text/plain",
      content: Buffer.from("uploaded via Buffer content", "utf8"),
    });
    log(`ok file id=${result.file.id}`);
  });

  // -------------------------------------------------------------------------
  // Section 9 — Error taxonomy via instanceof
  // -------------------------------------------------------------------------
  await runSection("9a. NotFoundError / ValidationError", async () => {
    try {
      await team.messages.send({
        channel: "C_DOES_NOT_EXIST",
        ...text("should fail"),
      });
      log("unexpected success");
    } catch (err) {
      describeSlackError(err);
    }
  });

  await runSection("9b. synchronous TypeError from coerceContent", async () => {
    try {
      await team.files.upload({
        channel,
        filename: "bad.bin",
        mimeType: "application/octet-stream",
        content: 123 as unknown as Uint8Array,
      });
      log("unexpected success");
    } catch (err) {
      const isSlack = err instanceof SlackError;
      log(
        `caught ${formatErrorClass(err)} (instanceof SlackError = ${isSlack})`
      );
      if (err instanceof Error) {
        log(`  message: ${err.message}`);
      }
    }
  });

  // -------------------------------------------------------------------------
  // Section 10 + 11 — Streaming + fetchMissed
  // -------------------------------------------------------------------------
  let lastCursor: string | undefined;

  if (skipStreaming) {
    log("\n=== 10–11. streaming sections skipped ===");
  } else {
    await runSection("10a. subscribe + .take(3)", async () => {
      const stream = team.events.subscribe({
        reconnect: {
          initialDelay: RECONNECT_INITIAL_DELAY_MS,
          maxDelay: RECONNECT_MAX_DELAY_MS,
          maxAttempts: RECONNECT_MAX_ATTEMPTS,
          multiplier: RECONNECT_MULTIPLIER,
          onReconnect: (attempt) => log(`  reconnecting (attempt ${attempt})`),
        },
      });
      const timeout = setTimeout(() => {
        log("  timeout reached, closing stream");
        stream.close().catch(() => undefined);
      }, STREAM_TIMEOUT_MS);
      try {
        for await (const ev of stream.take(3)) {
          handleEvent(ev);
          lastCursor = ev.cursor;
        }
      } finally {
        clearTimeout(timeout);
      }
    });

    await runSection("10b. subscribe + .filter (type-narrowing)", async () => {
      const stream = team.events.subscribe();
      const onlyMessages = stream.filter(
        (e): e is Extract<SlackEvent, { type: "message" }> =>
          e.type === "message"
      );
      const timeout = setTimeout(() => {
        onlyMessages.close().catch(() => undefined);
      }, STREAM_TIMEOUT_MS);
      try {
        for await (const ev of onlyMessages.take(1)) {
          // ev is typed as the "message" variant — no narrowing needed.
          log(
            `  message from ${ev.message.user}: ${ev.message.text.slice(0, 80)}`
          );
        }
      } finally {
        clearTimeout(timeout);
      }
    });

    await runSection("10c. subscribe + .map", async () => {
      const stream = team.events.subscribe();
      const projected = stream
        .map((e) => ({ type: e.type, cursor: e.cursor }))
        .take(1);
      const timeout = setTimeout(() => {
        projected.close().catch(() => undefined);
      }, STREAM_TIMEOUT_MS);
      try {
        for await (const ev of projected) {
          log(`  mapped: type=${ev.type} cursor=${ev.cursor}`);
        }
      } finally {
        clearTimeout(timeout);
      }
    });

    await runSection("10d. subscribe + .on() unsubscribe", async () => {
      const stream = team.events.subscribe();
      let count = 0;
      const unsubscribe = stream.on((ev) => {
        count += 1;
        log(`  on() received type=${ev.type} (count=${count})`);
      });
      await new Promise((resolve) => setTimeout(resolve, ON_CALLBACK_DELAY_MS));
      unsubscribe();
      log(`  unsubscribed after ${count} events`);
    });

    await runSection(
      "10e. subscribe + await using (asyncDispose)",
      async () => {
        await using stream = team.events.subscribe();
        const inner = stream.take(1);
        const timeout = setTimeout(() => {
          inner.close().catch(() => undefined);
        }, STREAM_TIMEOUT_MS);
        try {
          for await (const ev of inner) {
            handleEvent(ev);
            lastCursor = ev.cursor;
          }
        } finally {
          clearTimeout(timeout);
        }
        log("  block exiting — await using will dispose stream");
      }
    );

    await runSection("11. events.fetchMissed", async () => {
      if (!lastCursor) {
        log("skipped — no cursor captured (channel was quiet)");
        return;
      }
      const result = await team.events.fetchMissed({
        cursor: lastCursor,
        limit: FETCH_MISSED_LIMIT,
      });
      log(`ok events=${result.events.length} hasMore=${result.hasMore}`);
    });
  }

  // -------------------------------------------------------------------------
  // Section 12 — Custom CursorStore
  // -------------------------------------------------------------------------
  if (skipStreaming) {
    log("\n=== 12. custom CursorStore skipped (streaming disabled) ===");
  } else {
    await runSection("12. custom CursorStore (instrumented)", async () => {
      const instrumented = makeLoggingCursorStore();
      const client12 = createClient({
        tokenProvider: staticTokens({
          tokens: { [teamId]: token },
          teams: { [teamId]: teamMeta },
        }),
        spectrumSlackEndpoint: process.env.SPECTRUM_SLACK_ENDPOINT,
        cursorStore: instrumented,
      });
      try {
        const stream = client12.team(teamId).events.subscribe();
        const timeout = setTimeout(() => {
          stream.close().catch(() => undefined);
        }, CURSOR_STORE_TIMEOUT_MS);
        try {
          for await (const ev of stream.take(1)) {
            log(`  observed event type=${ev.type}`);
          }
        } finally {
          clearTimeout(timeout);
        }
      } finally {
        await client12.close();
      }
    });
  }

  // -------------------------------------------------------------------------
  // Section 13 + 14 — staticTokens TokenProvider + await using lifecycle
  // -------------------------------------------------------------------------
  await runSection("13–14. staticTokens + await using", async () => {
    await using staticClient = createClient({
      tokenProvider: staticTokens({
        tokens: { [teamId]: "ey.fake.jwt" },
        teams: {
          [teamId]: {
            teamName: "Acme (static)",
            botUserId: "U-BOT",
            appId: "A-APP",
            grantedScopes: ["chat:write"],
          },
        },
      }),
    });
    const staticTeams = await staticClient.teams();
    log(`staticTokens listTeams.size=${staticTeams.size}`);
    for (const [id, meta] of staticTeams) {
      log(
        `  ${id} name=${meta.teamName} scopes=[${meta.grantedScopes.join(",")}]`
      );
    }
    log("  (block exiting — await using will dispose staticClient)");
  });
} catch (err) {
  logError("top-level", err);
  process.exitCode = 1;
} finally {
  log("\n=== closing client ===");
  await client.close();
  log("done");
}

// ---------------------------------------------------------------------------
// Local helpers (declared after the top-level await is fine in ESM)
// ---------------------------------------------------------------------------

function handleEvent(ev: SlackEvent): void {
  switch (ev.type) {
    case "message":
      log(
        `  [message] user=${ev.message.user} ts=${ev.message.ts} text=${ev.message.text.slice(0, 80)}`
      );
      break;
    case "reaction":
      log(
        `  [reaction] ${ev.reaction.removed ? "removed" : "added"} ${ev.reaction.name} by ${ev.reaction.user}`
      );
      break;
    case "mention":
      log(`  [mention] user=${ev.mention.user} text=${ev.mention.text}`);
      break;
    case "interactive":
      log(
        `  [interactive] type=${ev.interactive.type} user=${ev.interactive.user}`
      );
      break;
    case "command":
      log(
        `  [command] /${ev.command.command} text=${ev.command.text} user=${ev.command.user}`
      );
      break;
    default: {
      const _exhaustive: never = ev;
      throw new Error(
        `unhandled event variant: ${JSON.stringify(_exhaustive)}`
      );
    }
  }
}

function describeSlackError(err: unknown): void {
  if (err instanceof AuthenticationError) {
    log(`AuthenticationError code=${err.code} grpc=${err.grpcCode}`);
    return;
  }
  if (err instanceof PermissionError) {
    log(`PermissionError kind=${err.permission.kind}`);
    if (err.permission.kind === "feature_not_enabled") {
      log(`  feature=${err.permission.feature}`);
    } else if (err.permission.kind === "other") {
      log(`  detail=${err.permission.detail ?? "<none>"}`);
    }
    return;
  }
  if (err instanceof NotFoundError) {
    log(`NotFoundError code=${err.code} msg=${err.message}`);
    return;
  }
  if (err instanceof RateLimitError) {
    log(`RateLimitError retryAfterMs=${err.retryAfterMs ?? "<none>"}`);
    return;
  }
  if (err instanceof ValidationError) {
    log(`ValidationError code=${err.code} msg=${err.message}`);
    return;
  }
  if (err instanceof ConnectionError) {
    log(`ConnectionError code=${err.code} msg=${err.message}`);
    return;
  }
  if (err instanceof SlackError) {
    log(
      `SlackError (base) code=${err.code} grpc=${err.grpcCode} retryable=${err.retryable}`
    );
    // Touch every ErrorCode constant so this section also documents the enum.
    if (err.code === ErrorCode.internalError) {
      log("  (note: ErrorCode.internalError reached)");
    }
    return;
  }
  log(`non-SlackError: ${formatErrorClass(err)}`);
}

function makeLoggingCursorStore(): CursorStore {
  // Wraps the in-memory default so we get the same semantics with logging.
  const inner = createInMemoryCursorStore();
  return {
    async get(id) {
      const value = await inner.get(id);
      log(`  cursorStore.get(${id}) -> ${value ?? "<undefined>"}`);
      return value;
    },
    async set(id, cursor) {
      log(`  cursorStore.set(${id}, ${cursor})`);
      await inner.set(id, cursor);
    },
  };
}
