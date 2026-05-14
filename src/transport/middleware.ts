/**
 * nice-grpc client middleware for authentication, retry, timeout, and
 * trailing metadata capture.
 *
 * Auth middleware is parameterized by `teamId` at the per-team client factory
 * boundary, so it stamps the right `team_id` metadata on every call without
 * any per-request plumbing. For unary calls it also retries exactly once on
 * UNAUTHENTICATED after invalidating the token cache.
 *
 * Retry middleware auto-retries unary calls on transient transport failures
 * (`UNAVAILABLE`, `DEADLINE_EXCEEDED`) and on the server-opt-in
 * `x-retryable: true` trailer. Typed server errors are never retried.
 */

import {
  type CallOptions,
  ClientError,
  type ClientMiddleware,
  Metadata,
  Status,
} from "nice-grpc-common";
import type { TokenProvider } from "../auth/token-provider";
import type { RetryOptions } from "../types/common";
import { readMetadataValue } from "../utils/grpc-metadata";
import { sleep } from "../utils/sleep";

export const DEFAULT_RETRY_OPTIONS = {
  maxAttempts: 4,
  initialDelay: 200,
  maxDelay: 5000,
} as const;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * Stamps `access_token` (JWT from the provider) and `team_id` metadata on
 * every call. On UNAUTHENTICATED for a unary call, invalidates the token
 * and retries exactly once. Streaming calls are not retried in-middleware —
 * the outer reconnect loop owns that.
 */
export function authMiddleware(
  tokenProvider: TokenProvider,
  teamId: string
): ClientMiddleware {
  return async function* authMw(call, options) {
    const stamp = async (md: Metadata) => {
      md.set("access_token", await tokenProvider.getAccessToken(teamId));
      md.set("team_id", teamId);
    };

    let metadata = Metadata(options.metadata);
    await stamp(metadata);

    try {
      return yield* call.next(call.request, { ...options, metadata });
    } catch (err) {
      const isUnauthenticated =
        err instanceof ClientError && err.code === Status.UNAUTHENTICATED;
      const isStream = call.method.responseStream || call.method.requestStream;

      if (isUnauthenticated && !isStream) {
        tokenProvider.invalidate(teamId);
        metadata = Metadata(options.metadata);
        await stamp(metadata);
        return yield* call.next(call.request, { ...options, metadata });
      }
      throw err;
    }
  };
}

// ---------------------------------------------------------------------------
// Retry (unary only)
// ---------------------------------------------------------------------------

/**
 * Retries unary calls under two conditions:
 *
 *   1. Transient transport failures: gRPC `UNAVAILABLE` (14) and
 *      `DEADLINE_EXCEEDED` (4). These are canonically retriable per the gRPC
 *      ecosystem convention and are typically returned by an intermediate
 *      proxy / load balancer before the request ever reaches the service
 *      handler. Without this, an upstream rate-limit or transient hiccup
 *      surfaces as `ConnectionError: unavailable` even though the next
 *      attempt would have produced a typed answer.
 *
 *   2. Server opt-in via the `x-retryable: true` trailing metadata. Reserved
 *      for typed errors the server explicitly marks as safe to retry.
 *      spectrum-slack does not currently emit this trailer, so this path is
 *      effectively dormant until the server opts in.
 *
 * Typed server errors (`INVALID_ARGUMENT`, `PERMISSION_DENIED`, `NOT_FOUND`,
 * `INTERNAL`, `UNAUTHENTICATED`, `FAILED_PRECONDITION`, `RESOURCE_EXHAUSTED`)
 * are *not* retried — they're the server's actual answer.
 */
export function retryMiddleware(opts: RetryOptions = {}): ClientMiddleware {
  const maxAttempts = Math.max(
    1,
    opts.maxAttempts ?? DEFAULT_RETRY_OPTIONS.maxAttempts
  );
  const initialDelay = opts.initialDelay ?? DEFAULT_RETRY_OPTIONS.initialDelay;
  const maxDelay = opts.maxDelay ?? DEFAULT_RETRY_OPTIONS.maxDelay;

  return async function* retryMw(call, options) {
    if (call.method.responseStream || call.method.requestStream) {
      return yield* call.next(call.request, options);
    }

    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return yield* call.next(call.request, options);
      } catch (error: unknown) {
        lastError = error;

        const isTransientGrpc =
          error instanceof ClientError &&
          (error.code === Status.UNAVAILABLE ||
            error.code === Status.DEADLINE_EXCEEDED);
        const serverOptedIn =
          readMetadataValue(error, "x-retryable") === "true";
        const retryable = isTransientGrpc || serverOptedIn;

        if (!retryable || attempt >= maxAttempts - 1) {
          throw error;
        }

        const exponentialDelay = initialDelay * 2 ** attempt;
        const cappedDelay = Math.min(exponentialDelay, maxDelay);
        await sleep(Math.random() * cappedDelay, options.signal);

        if (options.signal?.aborted) {
          throw error;
        }
      }
    }

    throw lastError;
  };
}

// ---------------------------------------------------------------------------
// Timeout (unary only)
// ---------------------------------------------------------------------------

export function timeoutMiddleware(timeoutMs: number): ClientMiddleware {
  return async function* timeoutMw(call, options) {
    if (call.method.responseStream || call.method.requestStream) {
      return yield* call.next(call.request, options);
    }

    if (options.signal) {
      const combined = AbortSignal.any([
        options.signal,
        AbortSignal.timeout(timeoutMs),
      ]);
      const next: CallOptions = { ...options, signal: combined };
      return yield* call.next(call.request, next);
    }

    return yield* call.next(call.request, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
    });
  };
}

// ---------------------------------------------------------------------------
// Trailing metadata capture — innermost middleware
// ---------------------------------------------------------------------------

/**
 * nice-grpc wraps `@grpc/grpc-js` errors into `ClientError`, dropping trailing
 * metadata in the process. This middleware intercepts `onTrailer` to capture
 * it and re-attaches it to errors in a format compatible with
 * `readMetadataValue`.
 */
export function trailingMetadataCaptureMiddleware(): ClientMiddleware {
  return async function* trailingMetadataCaptureMw(call, options) {
    let trailer: ReturnType<typeof Metadata> | undefined;

    try {
      return yield* call.next(call.request, {
        ...options,
        onTrailer(t) {
          trailer = t;
          options.onTrailer?.(t);
        },
      });
    } catch (error) {
      await Promise.resolve();

      if (trailer && error instanceof Error) {
        const captured = trailer;
        Object.defineProperty(error, "metadata", {
          value: {
            get(key: string): unknown[] {
              const val = captured.get(key);
              return val === undefined ? [] : [val];
            },
          },
          writable: true,
          configurable: true,
        });
      }
      throw error;
    }
  };
}
