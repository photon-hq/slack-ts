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
  /** Slack's `url_private`. Requires the bot token to download bytes. */
  readonly url: string;
}
