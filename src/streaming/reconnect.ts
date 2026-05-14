/**
 * Auto-reconnecting wrappers for async iterable streams.
 *
 * `withResumableReconnect` re-invokes the stream factory after a disconnect
 * with exponential backoff, draining missed events via the supplied
 * `fetchMissed(cursor)` callback before resuming the live stream.
 *
 * Extensions over the basic whatsapp-business-ts pattern:
 *
 * - `shouldStop(err)` — predicate to exit the loop without retrying (used for
 *   `PermissionError(platform_disabled)` per `PROTOCOL.md` §reconnect).
 * - `onCursorAdvance(cursor)` — invoked just before yielding any event that
 *   advanced the cursor, so callers can persist progress (e.g. CursorStore).
 * - `onError(err)` — invoked on every caught stream error, before the
 *   backoff decision. Used to invalidate the token cache on UNAUTHENTICATED.
 */

import type { ReconnectOptions } from "../types/common";

interface BackoffState {
  consecutiveFailures: number;
  delay: number;
}

interface ResolvedOptions {
  readonly initialDelay: number;
  readonly maxAttempts: number;
  readonly maxDelay: number;
  readonly multiplier: number;
  readonly onReconnect?: (attempt: number) => void;
}

export interface ResumableReconnectExtras {
  readonly onError?: (err: unknown) => void;
  readonly shouldStop?: (err: unknown) => boolean;
}

function resolveOptions(options?: ReconnectOptions): ResolvedOptions {
  return {
    initialDelay: options?.initialDelay ?? 1000,
    maxDelay: options?.maxDelay ?? 30_000,
    multiplier: options?.multiplier ?? 2,
    maxAttempts: options?.maxAttempts ?? Number.POSITIVE_INFINITY,
    onReconnect: options?.onReconnect,
  };
}

async function* consumeStream<T>(
  stream: AsyncIterable<T>,
  state: BackoffState,
  opts: ResolvedOptions
): AsyncGenerator<T> {
  let receivedAtLeastOne = false;

  for await (const event of stream) {
    if (!receivedAtLeastOne) {
      receivedAtLeastOne = true;
      state.consecutiveFailures = 0;
      state.delay = opts.initialDelay;
    }
    yield event;
  }
}

async function backoff(
  state: BackoffState,
  opts: ResolvedOptions
): Promise<boolean> {
  state.consecutiveFailures++;

  if (state.consecutiveFailures > opts.maxAttempts) {
    return false;
  }

  opts.onReconnect?.(state.consecutiveFailures);

  await sleep(state.delay);
  state.delay = Math.min(state.delay * opts.multiplier, opts.maxDelay);
  return true;
}

async function* gapFill<T>(
  fetchMissed: (cursor: string) => Promise<T[]>,
  getCursor: () => string | undefined
): AsyncGenerator<T> {
  const cursor = getCursor();
  if (!cursor) {
    return;
  }

  try {
    const missed = await fetchMissed(cursor);
    for (const event of missed) {
      yield event;
    }
  } catch {
    // Gap-fill failed — continue with live stream anyway.
  }
}

export function withResumableReconnect<T>(
  createStream: () => AsyncIterable<T>,
  fetchMissed: (cursor: string) => Promise<T[]>,
  getCursor: () => string | undefined,
  options?: ReconnectOptions & ResumableReconnectExtras
): AsyncIterable<T> {
  const opts = resolveOptions(options);
  const shouldStop = options?.shouldStop;
  const onError = options?.onError;

  async function* reconnecting(): AsyncGenerator<T> {
    const state: BackoffState = {
      consecutiveFailures: 0,
      delay: opts.initialDelay,
    };
    let isFirstConnect = true;
    const stopped = false;

    while (!stopped) {
      try {
        if (!isFirstConnect) {
          yield* gapFill(fetchMissed, getCursor);
        }

        isFirstConnect = false;
        yield* consumeStream(createStream(), state, opts);
      } catch (err) {
        onError?.(err);
        if (shouldStop?.(err)) {
          throw err;
        }
        // Fall through to backoff.
      }

      if (!(await backoff(state, opts))) {
        return;
      }
    }
  }

  return reconnecting();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
