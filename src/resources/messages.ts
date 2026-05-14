import { fromGrpcError } from "../errors/error-handler";
import type { MessageServiceClient } from "../transport/grpc-client";
import { mapSendParams } from "../transport/mapper";
import type { RequestOptions } from "../types/client";
import type { SendMessageParams, SendMessageResult } from "../types/messages";

export class MessagesResource {
  private readonly _client: MessageServiceClient;

  constructor(client: MessageServiceClient) {
    this._client = client;
  }

  async send(
    params: SendMessageParams,
    options?: RequestOptions
  ): Promise<SendMessageResult> {
    try {
      const request = mapSendParams(params);
      const response = await this._client.sendMessage(request, {
        signal: options?.signal,
      });
      return { ts: response.ts, channel: response.channel };
    } catch (err) {
      throw fromGrpcError(err);
    }
  }

  /**
   * Mark the channel as read up to the given message timestamp. Gated on the
   * `read-tracking` project feature: if not enabled, throws `PermissionError`
   * with `permission.kind === "feature_not_enabled"` and
   * `permission.feature === "read-tracking"`.
   */
  async markRead(
    params: { readonly channel: string; readonly ts: string },
    options?: RequestOptions
  ): Promise<void> {
    try {
      await this._client.markRead(
        { channel: params.channel, ts: params.ts },
        { signal: options?.signal }
      );
    } catch (err) {
      throw fromGrpcError(err);
    }
  }
}
