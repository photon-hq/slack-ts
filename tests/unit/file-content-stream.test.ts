import { describe, expect, it } from "bun:test";
import { ClientError, Status } from "nice-grpc-common";
import { ConnectionError, SlackError } from "../../src/errors/slack-error";
import type {
  GetContentRequest,
  GetContentResponse,
  GetUrlResponse,
  UploadResponse,
} from "../../src/generated/photon/slack/v1/file_service";
import { openContentStream } from "../../src/streaming/file-content-stream";
import type { FileServiceClient } from "../../src/transport/grpc-client";

interface AttemptScript {
  readonly frames: Iterable<GetContentResponse>;
  readonly throwAfter?: unknown;
}

interface CallLog {
  readonly fileId: string;
  readonly offset?: number;
}

/**
 * Returns a mock FileServiceClient whose `getContent` plays one scripted
 * attempt per call. Records request shape (fileId, offset). Use this to
 * simulate mid-stream drops and resume.
 */
function mockClient(scripts: readonly AttemptScript[]): {
  client: FileServiceClient;
  calls: CallLog[];
} {
  const calls: CallLog[] = [];
  let attemptIdx = 0;
  const getContent = (req: GetContentRequest) => {
    const script = scripts[attemptIdx];
    attemptIdx++;
    if (!script) {
      throw new Error(`mock: no attempt #${attemptIdx} scripted`);
    }
    calls.push({ fileId: req.fileId, offset: req.offset });
    async function* gen(): AsyncGenerator<GetContentResponse> {
      for (const frame of script.frames) {
        yield frame;
      }
      if (script.throwAfter) {
        throw script.throwAfter;
      }
    }
    return gen();
  };

  const client = {
    getContent,
    // unused but required by the type
    upload: () => Promise.resolve({} as UploadResponse),
    getUrl: () => Promise.resolve({} as GetUrlResponse),
  } as unknown as FileServiceClient;

  return { client, calls };
}

function header(
  size: number,
  offset = 0,
  name = "hello.txt",
  mimetype = "text/plain"
): GetContentResponse {
  return { header: { mimetype, name, size, offset } };
}

function chunk(...bytes: number[]): GetContentResponse {
  return { chunk: new Uint8Array(bytes) };
}

async function drain(content: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const c of content) {
    parts.push(c);
    n += c.length;
  }
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const noBackoff = {
  initialDelay: 0,
  maxDelay: 0,
  multiplier: 1,
};

const FILE_REPLACED_RE = /file_replaced_during_resume/;

describe("openContentStream", () => {
  it("yields header + concatenated chunks on happy path", async () => {
    const { client, calls } = mockClient([
      {
        frames: [header(5), chunk(1, 2, 3), chunk(4, 5)],
      },
    ]);

    const result = await openContentStream(client, "F1", undefined);
    expect(result.header).toEqual({
      mimeType: "text/plain",
      name: "hello.txt",
      size: 5,
    });
    expect(await drain(result.content)).toEqual(
      new Uint8Array([1, 2, 3, 4, 5])
    );
    expect(calls).toEqual([{ fileId: "F1", offset: undefined }]);
  });

  it("resumes from bytes_received_so_far on UNAVAILABLE mid-stream", async () => {
    const { client, calls } = mockClient([
      {
        frames: [header(5), chunk(1, 2, 3)],
        throwAfter: new ClientError("/x", Status.UNAVAILABLE, "boom"),
      },
      {
        // Reopen — server re-emits the header (echoing the resume offset),
        // then the remaining bytes.
        frames: [header(5, 3), chunk(4, 5)],
      },
    ]);

    const result = await openContentStream(client, "F1", {
      reconnect: noBackoff,
    });
    const bytes = await drain(result.content);
    expect(bytes).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    expect(calls).toEqual([
      { fileId: "F1", offset: undefined },
      { fileId: "F1", offset: 3 },
    ]);
  });

  it("throws on header fingerprint mismatch during resume", async () => {
    const { client } = mockClient([
      {
        frames: [header(5), chunk(1, 2)],
        throwAfter: new ClientError("/x", Status.UNAVAILABLE, "drop"),
      },
      {
        // Same offset echoed but size changed → server replaced the file.
        frames: [header(7, 2)],
      },
    ]);

    const result = await openContentStream(client, "F1", {
      reconnect: noBackoff,
    });
    await expect(drain(result.content)).rejects.toThrow(FILE_REPLACED_RE);
  });

  it("propagates UNAVAILABLE without resume when reconnect: false", async () => {
    const { client, calls } = mockClient([
      {
        frames: [header(5), chunk(1)],
        throwAfter: new ClientError("/x", Status.UNAVAILABLE, "drop"),
      },
    ]);

    const result = await openContentStream(client, "F1", {
      reconnect: false,
    });
    await expect(drain(result.content)).rejects.toBeInstanceOf(ConnectionError);
    expect(calls).toEqual([{ fileId: "F1", offset: undefined }]);
  });

  it("does not resume on non-UNAVAILABLE errors", async () => {
    const { client } = mockClient([
      {
        frames: [header(5), chunk(1)],
        throwAfter: new ClientError("/x", Status.INTERNAL, "oops"),
      },
    ]);

    const result = await openContentStream(client, "F1", {
      reconnect: noBackoff,
    });
    await expect(drain(result.content)).rejects.toBeInstanceOf(SlackError);
  });

  it("gives up after maxAttempts and rethrows", async () => {
    const { client, calls } = mockClient([
      {
        frames: [header(3)],
        throwAfter: new ClientError("/x", Status.UNAVAILABLE, "1"),
      },
      {
        frames: [header(3, 0)],
        throwAfter: new ClientError("/x", Status.UNAVAILABLE, "2"),
      },
    ]);

    const result = await openContentStream(client, "F1", {
      reconnect: { ...noBackoff, maxAttempts: 1 },
    });
    await expect(drain(result.content)).rejects.toBeInstanceOf(ConnectionError);
    // 1 initial + 1 resume = 2 calls total.
    expect(calls.length).toBe(2);
  });
});
