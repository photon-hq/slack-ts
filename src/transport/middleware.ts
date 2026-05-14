/**
 * nice-grpc client middleware for authentication, retry, timeout, and
 * trailing metadata capture.
 *
 * Auth middleware is parameterized by `teamId` at the per-team client factory
 * boundary, so it stamps the right `team_id` metadata on every call without
 * any per-request plumbing. For unary calls it also retries exactly once on
 * UNAUTHENTICATED after invalidating the token cache.
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
// Retry (unary only, gated on `x-retryable` trailing metadata)
// ---------------------------------------------------------------------------

/**
 * Retries unary calls only when the server explicitly marks the error as safe
 * to replay via `x-retryable: true` trailing metadata.
 *
 * The SDK deliberately does *not* auto-retry on `UNAVAILABLE` /
 * `DEADLINE_EXCEEDED` because those statuses can be returned after the
 * handler has already touched Slack (e.g., response stream torn down,
 * deadline hit post-Slack-call). Replaying in that window would silently
 * duplicate non-idempotent operations like `chat.postMessage`,
 * `reactions.add`, and `files.upload`. Only the server can prove a request
 * never reached Slack — that proof is the `x-retryable: true` trailer.
 *
 * Until spectrum-slack attaches the trailer on rate-limiter rejections, this
 * middleware is effectively dormant; transient transport failures surface as
 * `ConnectionError` to the caller.
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

        const retryable = readMetadataValue(error, "x-retryable") === "true";

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
