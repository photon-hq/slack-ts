import type { SlackEvent } from "./events";

// ---------------------------------------------------------------------------
// Retry / reconnection options
// ---------------------------------------------------------------------------

export interface RetryOptions {
  /** Initial delay in milliseconds before the first retry. Default `200`. */
  readonly initialDelay?: number;
  /** Maximum number of attempts including the initial call. Default `4`. */
  readonly maxAttempts?: number;
  /** Maximum delay in milliseconds between retries. Default `5000`. */
  readonly maxDelay?: number;
}

export interface ReconnectOptions {
  /** Initial delay in milliseconds before the first reconnect. Default `1000`. */
  readonly initialDelay?: number;
  /** Maximum number of consecutive reconnect attempts. Default `Infinity`. */
  readonly maxAttempts?: number;
  /** Maximum delay in milliseconds between retries. Default `30000`. */
  readonly maxDelay?: number;
  /** Multiplier applied to the delay after each failed attempt. Default `2`. */
  readonly multiplier?: number;
  /** Callback invoked before each reconnect attempt. */
  readonly onReconnect?: (attempt: number) => void;
}

// ---------------------------------------------------------------------------
// Subscribe / fetch missed
// ---------------------------------------------------------------------------

export interface SubscribeOptions {
  /** Resume from a previously saved cursor. Overrides the cursor store. */
  readonly cursor?: string;
  /** Reconnection configuration for automatic reconnects. */
  readonly reconnect?: ReconnectOptions;
}

export interface FetchMissedOptions {
  /** The cursor from the last received event. */
  readonly cursor: string;
  /** Maximum number of events to return. Server clamps to [1, 1000]. */
  readonly limit?: number;
}

export interface FetchMissedResult {
  readonly events: readonly SlackEvent[];
  readonly hasMore: boolean;
}
