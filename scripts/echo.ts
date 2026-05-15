#!/usr/bin/env bun

/**
 * Echo bot: subscribes to events for the first installed team and replies
 * in-thread to every plain user message with the same text.
 *
 * Usage:
 *   SPECTRUM_CLOUD_ENDPOINT=http://localhost:3000 \
 *   SPECTRUM_SLACK_ENDPOINT=localhost:50051 \
 *   bun run scripts/echo.ts
 *
 * Then enter your projectId + projectSecret at the prompt.
 */

import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { createClient, text } from "../src/index";

const rl = createInterface({ input: stdin, output: stdout });
const projectId = (await rl.question("projectId: ")).trim();
const projectSecret = (await rl.question("projectSecret: ")).trim();
rl.close();

const client = createClient({
  projectId,
  projectSecret,
  spectrumCloudEndpoint: process.env.SPECTRUM_CLOUD_ENDPOINT,
  spectrumSlackEndpoint: process.env.SPECTRUM_SLACK_ENDPOINT,
});

const teams = await client.teams();
const first = [...teams.entries()][0];
if (!first) {
  console.error("[echo] no installations for this project");
  await client.close();
  process.exit(1);
}
const [teamId, meta] = first;
// botUserId lets us drop our own echoes so we don't loop on ourselves.
const botUserId = meta.botUserId;
console.log(
  `[echo] team_id=${teamId} (${meta.teamName}) bot=${botUserId} — listening...`
);

const abort = new AbortController();
process.on("SIGINT", () => {
  console.log("\n[echo] caught SIGINT, closing...");
  abort.abort();
});

const team = client.team(teamId);
const stream = team.events.subscribe({
  signal: abort.signal,
  reconnect: {
    onReconnect: (attempt) =>
      console.log(`[echo] reconnecting (attempt ${attempt})`),
  },
});

// Track in-flight reply tasks so SIGINT can drain them before exit. Replies
// are fire-and-forget from the event loop's perspective: spectrum-slack
// serializes outbound Slack calls per team (tier-2: 1 req / 3 s) so awaiting
// in the for-await would block ingestion behind the workspace's outbound
// rate limit and starve later events.
const inflight = new Set<Promise<void>>();

async function handleMessage(ev: {
  message: {
    channel: string;
    files: ReadonlyArray<{ id: string }>;
    subtype?: string;
    text: string;
    threadTs?: string;
    ts: string;
    user: string;
  };
}): Promise<void> {
  const { user, channel, ts, threadTs, subtype } = ev.message;
  const body = ev.message.text;

  if (subtype) {
    return;
  }
  if (user === botUserId) {
    return;
  }
  if (!body && ev.message.files.length === 0) {
    return;
  }

  const replyThreadTs = threadTs ?? ts;

  try {
    if (body) {
      await team.messages.send({
        channel,
        threadTs: replyThreadTs,
        ...text(body),
      });
    }
    for (const f of ev.message.files) {
      try {
        const { header, bytes } = await team.files.getContentBuffer(f.id, {
          reconnect: {
            onReconnect: (attempt) =>
              console.log(
                `[echo] resuming download of ${f.id} (attempt ${attempt})`
              ),
          },
        });
        await team.files.upload({
          channel,
          threadTs: replyThreadTs,
          filename: header.name,
          mimeType: header.mimeType,
          content: bytes,
        });
        console.log(
          `[echo] forwarded file ${header.name} (${header.size} bytes)`
        );
      } catch (err) {
        console.error(`[echo] file forward failed for ${f.id}:`, err);
      }
    }
    if (body || ev.message.files.length > 0) {
      console.log(`[echo] replied in ${channel} (ts=${ts}, user=${user})`);
    }
  } catch (err) {
    console.error(`[echo] reply failed for ts=${ts}:`, err);
  }
}

function spawnReply(ev: {
  message: Parameters<typeof handleMessage>[0]["message"];
}): void {
  const task = handleMessage(ev).finally(() => {
    inflight.delete(task);
  });
  inflight.add(task);
}

try {
  for await (const ev of stream) {
    console.log(`[echo] event ${ev.type} cursor=${ev.cursor}`);
    console.log(JSON.stringify(ev, null, 2));
    if (ev.type !== "message") {
      continue;
    }
    spawnReply(ev);
  }
} catch (err) {
  if (!abort.signal.aborted) {
    console.error("[echo] stream ended with error:", err);
  }
}

console.log(
  `[echo] stream ended, draining ${inflight.size} pending reply(ies)`
);
await Promise.allSettled([...inflight]);
await client.close();
