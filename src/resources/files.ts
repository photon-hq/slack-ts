import { fromGrpcError } from "../errors/error-handler";
import { openContentStream } from "../streaming/file-content-stream";
import type { FileServiceClient } from "../transport/grpc-client";
import { mapFile, mapFileShare } from "../transport/mapper";
import type { RequestOptions } from "../types/client";
import type {
  GetContentBufferResult,
  GetContentOptions,
  GetContentResult,
  GetUrlResult,
  UploadOptions,
  UploadResult,
} from "../types/files";

export class FilesResource {
  private readonly _client: FileServiceClient;

  constructor(client: FileServiceClient) {
    this._client = client;
  }

  async upload(
    params: UploadOptions,
    options?: RequestOptions
  ): Promise<UploadResult> {
    // coerceContent throws synchronously on bad input; surface that directly
    // rather than laundering a client-side TypeError through fromGrpcError.
    const content = coerceContent(params.content);
    try {
      const response = await this._client.upload(
        {
          channel: params.channel,
          filename: params.filename,
          mimetype: params.mimeType,
          content,
          initialComment: params.initialComment,
          threadTs: params.threadTs,
        },
        { signal: options?.signal }
      );
      if (!response.file) {
        throw new Error("upload response missing file metadata");
      }
      return {
        file: mapFile(response.file),
        shares: response.shares.map(mapFileShare),
      };
    } catch (err) {
      throw fromGrpcError(err);
    }
  }

  async getUrl(
    fileId: string,
    options?: RequestOptions
  ): Promise<GetUrlResult> {
    try {
      const response = await this._client.getUrl(
        { fileId },
        { signal: options?.signal }
      );
      return { url: response.url };
    } catch (err) {
      throw fromGrpcError(err);
    }
  }

  /**
   * Download a file's bytes through spectrum-slack. The returned `header`
   * is the full file metadata (size is the *full* size, not the count
   * remaining after `offset`). The returned `content` async-iterable
   * yields bytes from `offset` (default `0`) to the end of the file in the
   * chunk sizes the server delivered.
   *
   * Auto-resumes on `UNAVAILABLE` mid-stream: the SDK reconnects with
   * `offset = bytes_received_so_far`, validates the header fingerprint
   * (`mimetype` / `name` / `size`) against the original, and resumes. A
   * mismatch surfaces as `SlackError("file_replaced_during_resume", ...)`.
   *
   * Pass `options.reconnect = false` to disable auto-resume.
   */
  async getContent(
    fileId: string,
    options?: GetContentOptions
  ): Promise<GetContentResult> {
    return openContentStream(this._client, fileId, options);
  }

  /** Convenience: drain `getContent` into a single `Uint8Array`. */
  async getContentBuffer(
    fileId: string,
    options?: GetContentOptions
  ): Promise<GetContentBufferResult> {
    const { header, content } = await this.getContent(fileId, options);
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const c of content) {
      chunks.push(c);
      total += c.length;
    }
    const bytes = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      bytes.set(c, off);
      off += c.length;
    }
    return { header, bytes };
  }
}

function coerceContent(
  input: Uint8Array | Buffer | ArrayBuffer | string
): Uint8Array {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  if (typeof input === "string") {
    return new TextEncoder().encode(input);
  }
  throw new TypeError(
    `files.upload: unsupported content type ${typeof input}; expected Uint8Array | Buffer | ArrayBuffer | string`
  );
}
