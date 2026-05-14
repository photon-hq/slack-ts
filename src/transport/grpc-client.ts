/**
 * Creates the shared nice-grpc channel and per-team service-client factories.
 *
 * One channel is shared across all teams. Each team gets its own pair of
 * service clients with a teamId-bound auth middleware, so the right
 * `team_id` metadata is stamped without per-request plumbing.
 */

import {
  type Channel,
  ChannelCredentials,
  createChannel,
  createClientFactory,
} from "nice-grpc";
import type { TokenProvider } from "../auth/token-provider";
import type { FileServiceClient } from "../generated/photon/slack/v1/file_service";
import { FileServiceDefinition } from "../generated/photon/slack/v1/file_service";
import type { MessageServiceClient } from "../generated/photon/slack/v1/message_service";
import { MessageServiceDefinition } from "../generated/photon/slack/v1/message_service";
import type { RetryOptions } from "../types/common";
import {
  authMiddleware,
  retryMiddleware,
  timeoutMiddleware,
  trailingMetadataCaptureMiddleware,
} from "./middleware";

export type { FileServiceClient } from "../generated/photon/slack/v1/file_service";
export type { MessageServiceClient } from "../generated/photon/slack/v1/message_service";

const DEFAULT_ENDPOINT = "slack.spectrum.photon.codes:443";

export interface ChannelOptions {
  readonly endpoint?: string;
}

/**
 * Create the shared gRPC channel. Use `ChannelCredentials.createInsecure()`
 * for localhost endpoints (convention for local dev).
 */
export function createSlackChannel(options?: ChannelOptions): Channel {
  const endpoint =
    options?.endpoint ??
    process.env.SPECTRUM_SLACK_ENDPOINT ??
    DEFAULT_ENDPOINT;
  const credentials = isLocalAddress(endpoint)
    ? ChannelCredentials.createInsecure()
    : ChannelCredentials.createSsl();

  return createChannel(endpoint, credentials, {
    "grpc.keepalive_time_ms": 60_000,
    "grpc.keepalive_timeout_ms": 20_000,
  });
}

export interface TeamClientOptions {
  readonly channel: Channel;
  readonly retry?: boolean | RetryOptions;
  readonly teamId: string;
  readonly timeout?: number;
  readonly tokenProvider: TokenProvider;
}

export interface TeamGrpcClients {
  readonly files: FileServiceClient;
  readonly messages: MessageServiceClient;
}

/**
 * Build the service clients for a single team. The auth middleware is bound
 * to `teamId` here, so every call automatically stamps the right metadata.
 */
export function createTeamGrpcClients(
  options: TeamClientOptions
): TeamGrpcClients {
  let factory = createClientFactory();

  if (options.retry) {
    const retryOpts = options.retry === true ? {} : options.retry;
    factory = factory.use(retryMiddleware(retryOpts));
  }
  if (options.timeout) {
    factory = factory.use(timeoutMiddleware(options.timeout));
  }
  factory = factory.use(authMiddleware(options.tokenProvider, options.teamId));
  factory = factory.use(trailingMetadataCaptureMiddleware());

  return {
    messages: factory.create(MessageServiceDefinition, options.channel),
    files: factory.create(FileServiceDefinition, options.channel),
  };
}

function isLocalAddress(addr: string): boolean {
  return (
    addr.startsWith("localhost:") ||
    addr.startsWith("127.0.0.1:") ||
    addr.startsWith("0.0.0.0:") ||
    addr.startsWith("[::1]:")
  );
}
