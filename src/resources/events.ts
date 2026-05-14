/**
 * EventsResource — wraps the gRPC `SubscribeEvents` (server-streaming) and
 * `FetchMissedEvents` (unary) RPCs.
 *
 * `subscribe()` returns a self-reconnecting iterator: on UNAVAILABLE it
 * backs off, drains catch-up via `fetchMissedEvents(lastCursor)`, then
 * resumes the live stream. On `PERMISSION_DENIED platform_disabled` the
 * loop exits without further retries (per `PROTOCOL.md` §reconnect).
 */

import type { TokenProvider } from "../auth/token-provider";
import { fromGrpcError } from "../errors/error-handler";
import { AuthenticationError, PermissionError } from "../errors/slack-error";
import type { SubscribeEventsResponse } from "../generated/photon/slack/v1/message_service";
import { TypedEventStream } from "../streaming/event-stream";
import { withResumableReconnect } from "../streaming/reconnect";
import type { MessageServiceClient } from "../transport/grpc-client";
import { mapEvent } from "../transport/mapper";
import type {
  FetchMissedOptions,
  FetchMissedResult,
  SubscribeOptions,
} from "../types/common";
import type { CursorStore } from "../types/cursor-store";
import type { SlackEvent } from "../types/events";

export interface EventsResourceConfig {
  readonly cursorStore: CursorStore;
  readonly teamId: string;
  readonly tokenProvider: TokenProvider;
}

export class EventsResource {
  private readonly _client: MessageServiceClient;
  private readonly _config: EventsResourceConfig;

  constructor(client: MessageServiceClient, config: EventsResourceConfig) {
    this._client = client;
    this._config = config;
  }

  subscribe(options?: SubscribeOptions): TypedEventStream<SlackEvent> {
    let lastCursor: string | undefined = options?.cursor;
    const teamId = this._config.teamId;
    const cursorStore = this._config.cursorStore;
    const tokenProvider = this._config.tokenProvider;
    const client = this._client;

    const initial = async (): Promise<void> => {
      if (lastCursor !== undefined) {
        return;
      }
      const stored = await cursorStore.get(teamId);
      if (typeof stored === "string" && stored.length > 0) {
        lastCursor = stored;
      }
    };

    const advanceCursor = (cursor: string): void => {
      lastCursor = cursor;
      // Fire-and-forget — sync stores resolve immediately, async stores can
      // settle in the background. Errors are the store implementation's
      // responsibility (e.g. retry with their own buffering).
      Promise.resolve(cursorStore.set(teamId, cursor)).catch(() => {
        // swallow
      });
    };

    async function* mergedStream(): AsyncGenerator<SlackEvent> {
      await initial();

      const stream = withResumableReconnect<SlackEvent>(
        () => mapLiveStream(client.subscribeEvents({}), teamId),
        (cursor) => fetchAllMissed(client, teamId, cursor),
        () => lastCursor,
        {
          ...options?.reconnect,
          shouldStop: (e) =>
            e instanceof PermissionError &&
            e.permission.kind === "platform_disabled",
          onError: (e) => {
            if (e instanceof AuthenticationError) {
              tokenProvider.invalidate(teamId);
            }
          },
        }
      );

      for await (const ev of stream) {
        if (ev.cursor && ev.cursor !== lastCursor) {
          advanceCursor(ev.cursor);
        }
        yield ev;
      }
    }

    return new TypedEventStream(mergedStream());
  }

  async fetchMissed(options: FetchMissedOptions): Promise<FetchMissedResult> {
    try {
      const r = await this._client.fetchMissedEvents({
        cursor: { opaque: options.cursor },
        limit: options.limit ?? 100,
      });
      const events: SlackEvent[] = [];
      for (const proto of r.events) {
        const ev = mapEvent(proto, this._config.teamId);
        if (ev) {
          events.push(ev);
        }
      }
      return { events, hasMore: r.hasMore };
    } catch (err) {
      throw fromGrpcError(err);
    }
  }
}

async function* mapLiveStream(
  rpcStream: AsyncIterable<SubscribeEventsResponse>,
  teamId: string
): AsyncGenerator<SlackEvent> {
  try {
    for await (const proto of rpcStream) {
      const ev = mapEvent(proto, teamId);
      if (ev) {
        yield ev;
      }
    }
  } catch (err) {
    throw fromGrpcError(err);
  }
}

const GAP_FILL_PAGE_SIZE = 200;

/**
 * Page through `FetchMissedEvents` from `startCursor` until the server reports
 * `hasMore: false` or returns an empty page. Exported for unit testing.
 */
export async function fetchAllMissed(
  client: MessageServiceClient,
  teamId: string,
  startCursor: string
): Promise<SlackEvent[]> {
  const all: SlackEvent[] = [];
  let next = startCursor;
  for (;;) {
    let r: Awaited<ReturnType<typeof client.fetchMissedEvents>>;
    try {
      r = await client.fetchMissedEvents({
        cursor: { opaque: next },
        limit: GAP_FILL_PAGE_SIZE,
      });
    } catch (err) {
      throw fromGrpcError(err);
    }
    for (const proto of r.events) {
      const c = proto.cursor?.opaque;
      if (typeof c === "string" && c.length > 0) {
        next = c;
      }
      const ev = mapEvent(proto, teamId);
      if (ev) {
        all.push(ev);
      }
    }
    if (!r.hasMore || r.events.length === 0) {
      break;
    }
  }
  return all;
}
