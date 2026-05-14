/**
 * Error class hierarchy for the Slack SDK.
 *
 * One unified hierarchy covers both gRPC errors (from spectrum-slack) and
 * REST errors (from spectrum-cloud's `/slack/tokens` mint endpoint).
 * `context.source` distinguishes the two when the caller needs it.
 */

import type { ErrorCode } from "../types/errors";

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

export interface SlackErrorOptions {
  /** The original error that caused this one. */
  readonly cause?: Error;
  /** Canonical error code. */
  readonly code: ErrorCode;
  /** Arbitrary key-value pairs providing additional context. */
  readonly context?: Record<string, string>;
  /** Numeric gRPC status code (mirrors `nice-grpc-common` Status enum). */
  readonly grpcCode: number;
  /** Whether the caller should retry the request. */
  readonly retryable: boolean;
}

// ---------------------------------------------------------------------------
// Permission sub-kind
// ---------------------------------------------------------------------------

export type PermissionKind =
  | { readonly kind: "feature_not_enabled"; readonly feature: string }
  | { readonly kind: "platform_disabled" }
  | { readonly kind: "team_not_owned" }
  | { readonly kind: "other"; readonly detail?: string };

// ---------------------------------------------------------------------------
// Base error
// ---------------------------------------------------------------------------

export class SlackError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly grpcCode: number;
  readonly context: Record<string, string>;

  constructor(message: string, options: SlackErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "SlackError";
    this.code = options.code;
    this.retryable = options.retryable;
    this.grpcCode = options.grpcCode;
    this.context = options.context ?? {};
  }
}

// ---------------------------------------------------------------------------
// Subclasses
// ---------------------------------------------------------------------------

/** Maps from gRPC `UNAUTHENTICATED` or HTTP 401. */
export class AuthenticationError extends SlackError {
  constructor(message: string, options: SlackErrorOptions) {
    super(message, options);
    this.name = "AuthenticationError";
  }
}

/**
 * Maps from gRPC `PERMISSION_DENIED` or HTTP 403.
 *
 * The `permission` field carries the parsed sub-kind so callers can
 * distinguish feature gates from platform-level disables without inspecting
 * the message string.
 */
export class PermissionError extends SlackError {
  readonly permission: PermissionKind;

  constructor(
    message: string,
    options: SlackErrorOptions,
    permission: PermissionKind
  ) {
    super(message, options);
    this.name = "PermissionError";
    this.permission = permission;
  }
}

/** Maps from gRPC `NOT_FOUND` or HTTP 404. */
export class NotFoundError extends SlackError {
  constructor(message: string, options: SlackErrorOptions) {
    super(message, options);
    this.name = "NotFoundError";
  }
}

/** Maps from gRPC `INVALID_ARGUMENT` / `FAILED_PRECONDITION` or HTTP 422. */
export class ValidationError extends SlackError {
  constructor(message: string, options: SlackErrorOptions) {
    super(message, options);
    this.name = "ValidationError";
  }
}

/**
 * Maps from gRPC `RESOURCE_EXHAUSTED` or HTTP 429.
 *
 * `retryAfterMs` is parsed from the `retry-after` trailing metadata
 * (gRPC: seconds, multiplied to ms) or the HTTP `Retry-After` header.
 */
export class RateLimitError extends SlackError {
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    options: SlackErrorOptions,
    retryAfterMs: number | undefined
  ) {
    super(message, options);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** Maps from gRPC `UNAVAILABLE` / `DEADLINE_EXCEEDED` or HTTP 5xx / network errors. */
export class ConnectionError extends SlackError {
  constructor(message: string, options: SlackErrorOptions) {
    super(message, options);
    this.name = "ConnectionError";
  }
}
