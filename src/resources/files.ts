import { fromGrpcError } from "../errors/error-handler";
import type { FileServiceClient } from "../transport/grpc-client";
import { mapFile } from "../transport/mapper";
import type { RequestOptions } from "../types/client";
import type { GetUrlResult, UploadOptions, UploadResult } from "../types/files";

export class FilesResource {
  private readonly _client: FileServiceClient;

  constructor(client: FileServiceClient) {
    this._client = client;
  }

  async upload(
    params: UploadOptions,
    options?: RequestOptions
  ): Promise<UploadResult> {
    try {
      const content = coerceContent(params.content);
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
      return { file: mapFile(response.file) };
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
  // Unreachable, but keep TypeScript happy.
  return new Uint8Array(0);
}
