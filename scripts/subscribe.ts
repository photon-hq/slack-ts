#!/usr/bin/env bun

/**
 * Subscribe to live events for the first available team.
 *
 * Usage:
 *   SPECTRUM_CLOUD_ENDPOINT=http://localhost:3000 \
 *   SPECTRUM_SLACK_ENDPOINT=localhost:50051 \
 *   bun run scripts/subscribe.ts
 *
 * Then enter your projectId + projectSecret at the prompt.
 */

import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { createClient } from "../src/index";

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
const teamIds = [...teams.keys()];
if (teamIds.length === 0) {
  console.error("[subscribe] no installations for this project");
  await client.close();
  process.exit(1);
}

const teamId = teamIds[0];
if (!teamId) {
  process.exit(1);
}
const meta = teams.get(teamId);
console.log(`[subscribe] using team_id=${teamId} (${meta?.teamName ?? ""})`);

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
