#!/usr/bin/env bun

/**
 * Subscribe to live events for one team.
 *
 * Usage:
 *   SPECTRUM_SLACK_ENDPOINT=localhost:50051 \
 *   bun run scripts/subscribe.ts
 *
 * Then enter your team_id and JWT at the prompt.
 */

import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { createClient, staticTokens } from "../src/index";

const rl = createInterface({ input: stdin, output: stdout });
const teamId = (await rl.question("teamId (T...): ")).trim();
const token = (await rl.question("token (eyJ...): ")).trim();
rl.close();

const client = createClient({
  tokenProvider: staticTokens({ tokens: { [teamId]: token } }),
  spectrumSlackEndpoint: process.env.SPECTRUM_SLACK_ENDPOINT,
});

console.log(`[subscribe] using team_id=${teamId}`);

const abort = new AbortController();
process.on("SIGINT", () => {
  console.log("\n[subscribe] caught SIGINT, closing...");
  abort.abort();
});

const stream = client.team(teamId).events.subscribe({
  reconnect: {
    onReconnect: (attempt) =>
      console.log(`[subscribe] reconnecting (attempt ${attempt})`),
  },
});

try {
  for await (const ev of stream) {
    if (abort.signal.aborted) {
      break;
    }
    console.log(`[${ev.type}] cursor=${ev.cursor}`);
    console.log(JSON.stringify(ev, null, 2));
  }
} catch (err) {
  console.error("[subscribe] stream ended with error:", err);
}

console.log("[subscribe] stream ended");
await client.close();
