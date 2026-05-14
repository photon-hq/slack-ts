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

/**
 * Run gap-fill and the live stream in parallel on reconnect: open the live
 * stream immediately so the server starts queuing fresh events, drain
 * `fetchMissed(cursor)` in full first, then yield anything the live stream
 * buffered during gap-fill, then keep yielding live until the stream ends or
 * errors. Per `PROTOCOL.md §reconnect`, the recommended SDK behavior is to
 * run these two in parallel.
 */
async function* reconnectWithParallelGapFill<T>(
  createStream: () => AsyncIterable<T>,
  fetchMissed: (cursor: string) => Promise<T[]>,
  getCursor: () => string | undefined,
  state: BackoffState,
  opts: ResolvedOptions
): AsyncGenerator<T> {
  // Open the live stream first so the underlying gRPC call is in flight while
  // gap-fill runs. Events arriving before we start yielding live get buffered
  // by the pump below.
  const liveIterator = createStream()[Symbol.asyncIterator]();
  const liveBuffer: T[] = [];
  let liveDone = false;
  let liveError: unknown;
  let wake: (() => void) | undefined;

  const pump = (async () => {
    try {
      for (;;) {
        const r = await liveIterator.next();
        if (r.done) {
          break;
        }
        liveBuffer.push(r.value);
        wake?.();
      }
    } catch (err) {
      liveError = err;
    } finally {
      liveDone = true;
      wake?.();
    }
  })();

  const markReceived = (): void => {
    state.consecutiveFailures = 0;
    state.delay = opts.initialDelay;
  };

  try {
    // 1. Drain gap-fill (silently no-op on cursor==undefined or fetch failure).
    const cursor = getCursor();
    if (cursor) {
      try {
        const missed = await fetchMissed(cursor);
        for (const event of missed) {
          markReceived();
          yield event;
        }
      } catch {
        // Gap-fill failed — fall through to live.
      }
    }

    // 2. Drain whatever the live stream buffered during gap-fill, then keep
    //    pulling live until done or error.
    for (;;) {
      if (liveBuffer.length > 0) {
        markReceived();
        // biome-ignore lint/style/noNonNullAssertion: length checked above
        yield liveBuffer.shift()!;
        continue;
      }
      if (liveError) {
        throw liveError;
      }
      if (liveDone) {
        return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = undefined;
    }
  } finally {
    // Ensure the pump promise settles so it can't dangle past the iterator.
    await liveIterator.return?.(undefined).catch(() => {
      // ignore
    });
    await pump.catch(() => {
      // already captured into liveError
    });
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

    for (;;) {
      try {
        if (isFirstConnect) {
          isFirstConnect = false;
          yield* consumeStream(createStream(), state, opts);
        } else {
          yield* reconnectWithParallelGapFill(
            createStream,
            fetchMissed,
            getCursor,
            state,
            opts
          );
        }
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
