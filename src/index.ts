// biome-ignore-all lint/performance/noBarrelFile: intentional public API surface
// Auth
export type { StaticTokensOptions } from "./auth/static-token-provider";
export { staticTokens } from "./auth/static-token-provider";
export type { TeamMetadata, TokenProvider } from "./auth/token-provider";
// Builders — Block Kit
export {
  actions,
  button,
  context,
  divider,
  header,
  image,
  input,
  richText,
  section,
  video,
} from "./builders/blockkit";
// Builders — content
export { attachments, blocks, reaction, text } from "./builders/content";
export type { SlackClient, TeamClient } from "./client";
export { createClient } from "./client";

// Errors
export {
  AuthenticationError,
  ConnectionError,
  NotFoundError,
  PermissionError,
  type PermissionKind,
  RateLimitError,
  SlackError,
  ValidationError,
} from "./errors/slack-error";

// Resources (type-only — instances accessed via client.team())
export type { EventsResource } from "./resources/events";
export type { FilesResource } from "./resources/files";
export type { MessagesResource } from "./resources/messages";

// Streaming
export { TypedEventStream } from "./streaming/event-stream";

// Types
export type { ClientOptions, RequestOptions } from "./types/client";
export type {
  FetchMissedOptions,
  FetchMissedResult,
  ReconnectOptions,
  RetryOptions,
  SubscribeOptions,
} from "./types/common";
export type { CursorStore } from "./types/cursor-store";
export { createInMemoryCursorStore } from "./types/cursor-store";
export { ErrorCode } from "./types/errors";
export type {
  AppMentionEvent,
  InboundMessage,
  InteractiveCallbackEvent,
  ReactionEvent,
  SlackEvent,
  SlackFile,
  SlashCommandEvent,
} from "./types/events";
export type {
  FileContentHeader,
  FileShare,
  GetContentBufferResult,
  GetContentOptions,
  GetContentResult,
  GetUrlResult,
  UploadOptions,
  UploadResult,
} from "./types/files";
export type { WhoAmIResult } from "./types/identity";
export type { SendMessageParams, SendMessageResult } from "./types/messages";
