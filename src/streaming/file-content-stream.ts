/**
 * Resumable byte stream for `FileService.GetContent`.
 *
 * Opens the server-streaming RPC, surfaces the header, and yields chunks.
 * On `UNAVAILABLE` (transient pod / network blip) it re-opens the RPC with
 * `offset = bytes_received_so_far` so the SDK doesn't redownload bytes it
 * already has. Per `PROTOCOL.md` § `FileService.GetContent` the server sends
 * a header frame on every (re)connect; the wrapper validates the header
 * fingerprint (`mimetype` / `name` / `size`) against the original — a
 * mismatch means the file was replaced server-side and we surface
 * `SlackError("file_replaced_during_resume")` so the caller can decide
 * whether to restart from offset 0.
 */

import { Status } from "nice-grpc-common";
import { fromGrpcError } from "../errors/error-handler";
import { ConnectionError, SlackError } from "../errors/slack-error";
import type {
  FileServiceClient,
  GetContentResponse,
} from "../generated/photon/slack/v1/file_service";
import { ErrorCode } from "../types/errors";
import type {
  FileContentHeader,
  GetContentOptions,
  GetContentResult,
} from "../types/files";

const DEFAULT_INITIAL_DELAY = 1000;
const DEFAULT_MAX_DELAY = 30_000;
const DEFAULT_MULTIPLIER = 2;

interface ResolvedReconnect {
  readonly initialDelay: number;
  readonly maxAttempts: number;
  readonly maxDelay: number;
  readonly multiplier: number;
  readonly onReconnect?: (attempt: number) => void;
}

function resolveReconnect(
  opts: GetContentOptions["reconnect"]
): ResolvedReconnect | undefined {
  if (opts === false) {
    return undefined;
  }
  const r = opts ?? {};
  return {
    initialDelay: r.initialDelay ?? DEFAULT_INITIAL_DELAY,
    maxAttempts: r.maxAttempts ?? Number.POSITIVE_INFINITY,
    maxDelay: r.maxDelay ?? DEFAULT_MAX_DELAY,
    multiplier: r.multiplier ?? DEFAULT_MULTIPLIER,
    onReconnect: r.onReconnect,
  };
}

function headersMatch(a: FileContentHeader, b: FileContentHeader): boolean {
  return a.mimeType === b.mimeType && a.name === b.name && a.size === b.size;
}

function fingerprintMismatchError(
  a: FileContentHeader,
  b: FileContentHeader
): SlackError {
  return new SlackError(
    `file_replaced_during_resume: original=${a.mimeType}/${a.name}/${a.size}, on_resume=${b.mimeType}/${b.name}/${b.size}`,
    {
      code: ErrorCode.internalError,
      retryable: false,
      grpcCode: Status.ABORTED,
      context: { source: "grpc" },
    }
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function toHeader(
  frame: GetContentResponse["header"]
): FileContentHeader | undefined {
  if (!frame) {
    return undefined;
  }
  return {
    mimeType: frame.mimetype,
    name: frame.name,
    // ts-proto maps int64 → number; sizes up to 2^53 - 1 are safe.
    size: Number(frame.size),
  };
}

interface StreamState {
  bytesReceived: number;
  readonly canonical: FileContentHeader;
}

/**
 * Drain one connection: yield each `chunk` frame, validate any in-stream
 * header frames against the fingerprint, and return on clean end. Throws
 * up to the caller on transport error — the caller decides whether to
 * resume.
 */
async function* drainOnce(
  iter: AsyncIterator<GetContentResponse>,
  state: StreamState
): AsyncGenerator<Uint8Array> {
  for (;;) {
    const r = await iter.next();
    if (r.done) {
      return;
    }
    const maybeHeader = toHeader(r.value.header);
    if (maybeHeader) {
      if (!headersMatch(state.canonical, maybeHeader)) {
        throw fingerprintMismatchError(state.canonical, maybeHeader);
      }
      continue;
    }
    const chunk = r.value.chunk;
    if (chunk && chunk.length > 0) {
      state.bytesReceived += chunk.length;
      yield chunk;
    }
  }
}

async function reopenAndValidate(
  client: FileServiceClient,
  fileId: string,
  state: StreamState,
  signal: AbortSignal | undefined
): Promise<AsyncIterator<GetContentResponse>> {
  const reopened = await openOnce(client, fileId, state.bytesReceived, signal);
  if (!headersMatch(state.canonical, reopened.header)) {
    throw fingerprintMismatchError(state.canonical, reopened.header);
  }
  return reopened.iter;
}

interface BackoffState {
  attempts: number;
  delay: number;
}

function resetBackoff(
  state: BackoffState,
  reconnect: ResolvedReconnect | undefined
): void {
  state.attempts = 0;
  state.delay = reconnect?.initialDelay ?? DEFAULT_INITIAL_DELAY;
}

/**
 * Handle one stream-drain failure: rethrow if non-resumable or attempts
 * exhausted, otherwise back off and return (caller reopens). Maps the
 * raw thrown value to a SlackError on the way out.
 */
async function backoffOrThrow(
  err: unknown,
  state: BackoffState,
  reconnect: ResolvedReconnect | undefined,
  signal: AbortSignal | undefined
): Promise<void> {
  const mapped = err instanceof SlackError ? err : fromGrpcError(err);
  // Only UNAVAILABLE is auto-resumed. OUT_OF_RANGE / UNIMPLEMENTED map to
  // base SlackError today and surface to the caller, which can reopen
  // with offset = 0 if it wants to retry.
  if (!(reconnect && mapped instanceof ConnectionError)) {
    throw mapped;
  }
  state.attempts++;
  if (state.attempts > reconnect.maxAttempts) {
    throw mapped;
  }
  reconnect.onReconnect?.(state.attempts);
  await sleep(state.delay, signal);
  state.delay = Math.min(
    state.delay * reconnect.multiplier,
    reconnect.maxDelay
  );
}

/**
 * Open a `GetContent` stream and return the header + a resumable chunk
 * iterator. The promise resolves once the first header frame has been
 * received, so callers see `result.header` populated before any chunk
 * arrives.
 *
 * The chunk iterator handles mid-stream `UNAVAILABLE` by reconnecting with
 * `offset = bytes_received_so_far`. It re-throws on any other error, when
 * `reconnect: false`, when `maxAttempts` is exhausted, or when the server
 * delivers a different header fingerprint on resume (file replacement).
 */
export async function openContentStream(
  client: FileServiceClient,
  fileId: string,
  options: GetContentOptions | undefined
): Promise<GetContentResult> {
  const startOffset = options?.offset ?? 0;
  const signal = options?.signal;
  const reconnect = resolveReconnect(options?.reconnect);

  // Open the first connection and pull the header before returning so the
  // caller sees `result.header` populated before any chunk arrives.
  const opened = await openOnce(client, fileId, startOffset, signal);
  const state: StreamState = {
    bytesReceived: startOffset,
    canonical: opened.header,
  };

  async function* chunks(): AsyncGenerator<Uint8Array> {
    let iter: AsyncIterator<GetContentResponse> | undefined = opened.iter;
    const backoff: BackoffState = { attempts: 0, delay: 0 };
    resetBackoff(backoff, reconnect);

    for (;;) {
      if (!iter) {
        iter = await reopenAndValidate(client, fileId, state, signal);
      }
      const bytesAtStart = state.bytesReceived;
      try {
        yield* drainOnce(iter, state);
        return;
      } catch (err) {
        iter = undefined;
        // Real progress on this attempt resets the consecutive-failure
        // counter; pure reopen-without-bytes does not.
        if (state.bytesReceived > bytesAtStart) {
          resetBackoff(backoff, reconnect);
        }
        await backoffOrThrow(err, backoff, reconnect, signal);
      }
    }
  }

  return { header: opened.header, content: chunks() };
}

/**
 * Open a single connection: get the iterator, advance to the first frame
 * (the header), and return both. Throws via `fromGrpcError` on RPC errors.
 */
async function openOnce(
  client: FileServiceClient,
  fileId: string,
  offset: number,
  signal: AbortSignal | undefined
): Promise<{
  header: FileContentHeader;
  iter: AsyncIterator<GetContentResponse>;
}> {
  const stream = client.getContent(
    offset > 0 ? { fileId, offset } : { fileId },
    { signal }
  );
  const iter = stream[Symbol.asyncIterator]();
  let first: IteratorResult<GetContentResponse>;
  try {
    first = await iter.next();
  } catch (err) {
    throw fromGrpcError(err);
  }
  if (first.done) {
    throw new SlackError("getContent: stream closed before header frame", {
      code: ErrorCode.internalError,
      retryable: false,
      grpcCode: Status.INTERNAL,
      context: { source: "grpc" },
    });
  }
  const header = toHeader(first.value.header);
  if (!header) {
    throw new SlackError("getContent: first frame was not a header", {
      code: ErrorCode.internalError,
      retryable: false,
      grpcCode: Status.INTERNAL,
      context: { source: "grpc" },
    });
  }
  return { header, iter };
}
