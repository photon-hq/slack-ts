#!/usr/bin/env bun

/**
 * Send a one-shot text message to a channel for smoke testing.
 *
 * Usage:
 *   SPECTRUM_SLACK_ENDPOINT=localhost:50051 \
 *   bun run scripts/send.ts
 */

import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { createClient, staticTokens } from "../src/index";

const rl = createInterface({ input: stdin, output: stdout });
const teamId = (await rl.question("teamId (T...): ")).trim();
const token = (await rl.question("token (eyJ...): ")).trim();
const channel = (await rl.question("channel (C... | D... | U...): ")).trim();
const body = await rl.question("text: ");
rl.close();

const client = createClient({
  tokenProvider: staticTokens({ tokens: { [teamId]: token } }),
  spectrumSlackEndpoint: process.env.SPECTRUM_SLACK_ENDPOINT,
});

try {
  const result = await client.team(teamId).messages.send({
    channel,
    text: body,
  });
  console.log(`[send] ok ts=${result.ts} channel=${result.channel}`);
} catch (err) {
  console.error("[send] failed:", err);
  process.exitCode = 1;
} finally {
  await client.close();
}
