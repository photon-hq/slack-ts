import type { TokenProvider } from "../auth/token-provider";
import type { RetryOptions } from "./common";
import type { CursorStore } from "./cursor-store";

export interface ClientOptions {
  /** Persistent cursor storage. Default is in-memory. */
  readonly cursorStore?: CursorStore;
  /**
   * Enable automatic retry with exponential backoff for retryable unary calls.
   * Note: `spectrum-slack` does not currently set the `x-retryable` trailing
   * metadata the middleware looks for, so this is wired but effectively inert
   * until the server opts in.
   */
  readonly retry?: boolean | RetryOptions;
  /** Override the spectrum-slack gRPC endpoint (e.g. for local dev). */
  readonly spectrumSlackEndpoint?: string;
  /** Default timeout in milliseconds for unary RPC calls. */
  readonly timeout?: number;
  /**
   * Token source the SDK uses to resolve per-team JWTs. Use
   * `staticTokens({...})` or implement `TokenProvider` directly.
   */
  readonly tokenProvider: TokenProvider;
}

export interface RequestOptions {
  /** Abort signal for cancelling the request. */
  readonly signal?: AbortSignal;
}
