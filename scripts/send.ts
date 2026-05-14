#!/usr/bin/env bun

/**
 * Send a one-shot text message to a channel for smoke testing.
 *
 * Usage:
 *   SPECTRUM_CLOUD_ENDPOINT=http://localhost:3000 \
 *   SPECTRUM_SLACK_ENDPOINT=localhost:50051 \
 *   bun run scripts/send.ts
 */

import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { createClient } from "../src/index";

const rl = createInterface({ input: stdin, output: stdout });
const projectId = (await rl.question("projectId: ")).trim();
const projectSecret = (await rl.question("projectSecret: ")).trim();
const teamId = (await rl.question("teamId (T...): ")).trim();
const channel = (await rl.question("channel (C... | D... | U...): ")).trim();
const body = await rl.question("text: ");
rl.close();

const client = createClient({
  projectId,
  projectSecret,
  spectrumCloudEndpoint: process.env.SPECTRUM_CLOUD_ENDPOINT,
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
