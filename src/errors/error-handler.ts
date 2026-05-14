/**
 * Sibling factories that convert raw gRPC errors and spectrum-cloud REST
 * responses into the unified `SlackError` hierarchy.
 *
 * gRPC mapping (table in `PROTOCOL.md` §5):
 *
 * | gRPC status                            | SDK error class      |
 * | -------------------------------------- | -------------------- |
 * | UNAUTHENTICATED                        | AuthenticationError  |
 * | PERMISSION_DENIED                      | PermissionError      |
 * | NOT_FOUND                              | NotFoundError        |
 * | RESOURCE_EXHAUSTED                     | RateLimitError       |
 * | INVALID_ARGUMENT, FAILED_PRECONDITION  | ValidationError      |
 * | UNAVAILABLE, DEADLINE_EXCEEDED         | ConnectionError      |
 * | Everything else                        | SlackError (base)    |
 */

import { ClientError, Status } from "nice-grpc-common";
import { ErrorCode } from "../types/errors";
import { readMetadataValue } from "../utils/grpc-metadata";
import {
  AuthenticationError,
  ConnectionError,
  NotFoundError,
  PermissionError,
  type PermissionKind,
  RateLimitError,
  SlackError,
  type SlackErrorOptions,
  ValidationError,
} from "./slack-error";

// ---------------------------------------------------------------------------
// PERMISSION_DENIED message → PermissionKind
// ---------------------------------------------------------------------------

const FEATURE_RE = /^feature_not_enabled:(.+)$/;

export function parsePermissionKind(message: string): PermissionKind {
  const m = FEATURE_RE.exec(message);
  if (m?.[1]) {
    return { kind: "feature_not_enabled", feature: m[1] };
  }
  if (
    message === "platform_disabled" ||
    message.includes("platform_disabled")
  ) {
    return { kind: "platform_disabled" };
  }
  if (message.includes("team_id not owned")) {
    return { kind: "team_not_owned" };
  }
  return { kind: "other", detail: message };
}

// ---------------------------------------------------------------------------
// retry-after — Slack/spectrum-slack emits seconds; convert to ms.
// ---------------------------------------------------------------------------

function parseRetryAfterMs(error: unknown): number | undefined {
  const raw = readMetadataValue(error, "retry-after");
  if (raw === undefined) {
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return undefined;
  }
  return Math.round(n * 1000);
}

// ---------------------------------------------------------------------------
// gRPC → SlackError
// ---------------------------------------------------------------------------

export function fromGrpcError(error: unknown): SlackError {
  const isClientError = error instanceof ClientError;

  let grpcCode: number;
  if (isClientError) {
    grpcCode = error.code;
  } else if (typeof (error as { code?: unknown }).code === "number") {
    grpcCode = (error as { code: number }).code;
  } else {
    grpcCode = Status.UNKNOWN;
  }

  let details: string;
  if (isClientError) {
    details = error.details;
  } else if (typeof (error as { details?: unknown }).details === "string") {
    details = (error as { details: string }).details;
  } else if (error instanceof Error) {
    details = error.message;
  } else {
    details = String(error);
  }

  const errorCode =
    (readMetadataValue(error, "error-code") as ErrorCode | undefined) ??
    ErrorCode.internalError;
  const retryable = readMetadataValue(error, "x-retryable") === "true";
  const cause = error instanceof Error ? error : undefined;

  const options: SlackErrorOptions = {
    code: errorCode,
    retryable,
    grpcCode,
    cause,
    context: { source: "grpc" },
  };

  switch (grpcCode) {
    case Status.UNAUTHENTICATED:
      return new AuthenticationError(details, options);

    case Status.PERMISSION_DENIED:
      return new PermissionError(
        details,
        options,
        parsePermissionKind(details)
      );

    case Status.NOT_FOUND:
      return new NotFoundError(details, options);

    case Status.RESOURCE_EXHAUSTED:
      return new RateLimitError(details, options, parseRetryAfterMs(error));

    case Status.INVALID_ARGUMENT:
    case Status.FAILED_PRECONDITION:
      return new ValidationError(details, options);

    case Status.UNAVAILABLE:
    case Status.DEADLINE_EXCEEDED:
      return new ConnectionError(details, options);

    default:
      return new SlackError(details, options);
  }
}

// ---------------------------------------------------------------------------
// spectrum-cloud REST → SlackError
// ---------------------------------------------------------------------------

/**
 * Convert a non-OK spectrum-cloud REST response (or a network failure) into a
 * `SlackError`. `body` is the parsed envelope `{ succeed: false, code, message }`
 * if available; pass `undefined` otherwise.
 *
 * For network failures (fetch rejected), call `fromCloudNetworkError(err)`.
 */
export function fromCloudResponse(
  res: Response,
  body?: { readonly code?: string; readonly message?: string }
): SlackError {
  const status = res.status;
  const cloudCode = body?.code ?? "";
  const message = body?.message ?? `spectrum-cloud http ${status}`;

  const retryAfterHeader = res.headers.get("retry-after");
  const retryAfterMs = parseRetryAfterHeader(retryAfterHeader);

  const context: Record<string, string> = {
    source: "spectrum-cloud",
    httpStatus: String(status),
  };
  if (cloudCode) {
    context.cloudCode = cloudCode;
  }

  const base: SlackErrorOptions = {
    code: mapCloudCodeToErrorCode(status, cloudCode),
    retryable: status >= 500 || status === 429,
    grpcCode: mapHttpStatusToGrpcCode(status),
    context,
  };

  if (status === 401) {
    return new AuthenticationError(message, base);
  }
  if (status === 403) {
    return new PermissionError(message, base, parsePermissionKind(message));
  }
  if (status === 404) {
    return new NotFoundError(message, base);
  }
  if (
    status === 422 ||
    cloudCode === "VALIDATION_ERROR" ||
    cloudCode === "MALFORMED_REQUEST"
  ) {
    return new ValidationError(message, base);
  }
  if (status === 429) {
    return new RateLimitError(message, base, retryAfterMs);
  }
  if (status >= 500) {
    return new ConnectionError(message, base);
  }

  return new SlackError(message, base);
}

export function fromCloudNetworkError(err: unknown): ConnectionError {
  const cause = err instanceof Error ? err : undefined;
  const message =
    cause?.message ?? (typeof err === "string" ? err : "network error");

  return new ConnectionError(message, {
    code: ErrorCode.networkError,
    retryable: true,
    grpcCode: Status.UNAVAILABLE,
    cause,
    context: { source: "spectrum-cloud" },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseRetryAfterHeader(raw: string | null): number | undefined {
  if (!raw) {
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return undefined;
  }
  return Math.round(n * 1000);
}

function mapCloudCodeToErrorCode(status: number, cloudCode: string): ErrorCode {
  if (status === 401) {
    return ErrorCode.unauthenticated;
  }
  if (status === 403) {
    return ErrorCode.unauthorized;
  }
  if (status === 404 || cloudCode === "NOT_FOUND") {
    return ErrorCode.notFound;
  }
  if (
    status === 422 ||
    cloudCode === "VALIDATION_ERROR" ||
    cloudCode === "MALFORMED_REQUEST"
  ) {
    return ErrorCode.invalidArgument;
  }
  if (status === 429) {
    return ErrorCode.rateLimitExceeded;
  }
  if (status >= 500) {
    return ErrorCode.serviceUnavailable;
  }
  return ErrorCode.internalError;
}

function mapHttpStatusToGrpcCode(status: number): number {
  if (status === 401) {
    return Status.UNAUTHENTICATED;
  }
  if (status === 403) {
    return Status.PERMISSION_DENIED;
  }
  if (status === 404) {
    return Status.NOT_FOUND;
  }
  if (status === 422) {
    return Status.INVALID_ARGUMENT;
  }
  if (status === 429) {
    return Status.RESOURCE_EXHAUSTED;
  }
  if (status >= 500) {
    return Status.UNAVAILABLE;
  }
  return Status.UNKNOWN;
}
