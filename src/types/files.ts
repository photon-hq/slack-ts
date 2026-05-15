import type { ReconnectOptions } from "./common";
import type { SlackFile } from "./events";

export interface UploadOptions {
  /** Slack channel id (or comma-separated list of channel ids) to share into. */
  readonly channel: string;
  readonly content: Uint8Array | Buffer | ArrayBuffer | string;
  readonly filename: string;
  /** Optional initial comment to post alongside the file. */
  readonly initialComment?: string;
  readonly mimeType: string;
  /** Share into a thread. */
  readonly threadTs?: string;
}

export interface UploadResult {
  readonly file: SlackFile;
}

export interface GetUrlResult {
  /** Slack's `url_private`. Requires the bot token to download bytes — use
   *  `getContent` instead if you want the actual file bytes. */
  readonly url: string;
}

export interface FileContentHeader {
  readonly mimeType: string;
  readonly name: string;
  /** Full file size in bytes (not the count remaining when resuming). */
  readonly size: number;
}

export interface GetContentOptions {
  /** Resume from this byte offset. Default `0` (stream from the start). */
  readonly offset?: number;
  /**
   * Mid-stream reconnect behavior. Pass `false` to disable auto-resume on
   * transient `UNAVAILABLE` / network drops. Default: enabled with the
   * standard exponential-backoff settings.
   */
  readonly reconnect?: ReconnectOptions | false;
  /** Cancellation signal. Aborting closes the underlying stream. */
  readonly signal?: AbortSignal;
}

export interface GetContentResult {
  /**
   * Bytes from `offset` to end of file, yielded in the chunk sizes the
   * server sent (≤ 256 KiB per chunk by default). Iterator throws on
   * non-resumable errors and on mid-resume file replacement.
   */
  readonly content: AsyncIterable<Uint8Array>;
  readonly header: FileContentHeader;
}

export interface GetContentBufferResult {
  /** Concatenated bytes from `offset` to end of file. */
  readonly bytes: Uint8Array;
  readonly header: FileContentHeader;
}
