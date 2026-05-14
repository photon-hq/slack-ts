import { describe, expect, it } from "bun:test";
import {
  ClientError,
  type ClientMiddlewareCall,
  Status,
} from "nice-grpc-common";
import { retryMiddleware } from "../../src/transport/middleware";

type Outcome<T> = T | Error;

function clientErrorWithMetadata(
  code: Status,
  message: string,
  metadata: Record<string, string>
): ClientError {
  const err = new ClientError("/svc/method", code, message);
  Object.defineProperty(err, "metadata", {
    value: {
      get(key: string): unknown[] {
        const v = metadata[key];
        return v === undefined ? [] : [v];
      },
    },
    writable: true,
    configurable: true,
  });
  return err;
}

function makeUnaryCall<Res>(
  outcomes: Outcome<Res>[],
  counter: { count: number }
): ClientMiddlewareCall<unknown, Res> {
  return {
    method: {
      requestStream: false,
      responseStream: false,
      path: "/test/Method",
    },
    request: undefined,
    async *next() {
      const i = counter.count++;
      const outcome = outcomes[i];
      if (outcome instanceof Error) {
        throw outcome;
      }
      yield outcome as Res;
    },
  } as unknown as ClientMiddlewareCall<unknown, Res>;
}

async function consume<Res>(
  mw: ReturnType<typeof retryMiddleware>,
  call: ClientMiddlewareCall<unknown, Res>,
  options: { signal?: AbortSignal } = {}
): Promise<Res> {
  const gen = (
    mw as unknown as (
      c: ClientMiddlewareCall<unknown, Res>,
      o: typeof options
    ) => AsyncGenerator<Res, Res | undefined, undefined>
  )(call, options);
  let last: Res | undefined;
  while (true) {
    const r = await gen.next();
    if (r.done) {
      if (r.value !== undefined) {
        last = r.value as Res;
      }
      break;
    }
    last = r.value;
  }
  return last as Res;
}

describe("retryMiddleware", () => {
  const fastOpts = { maxAttempts: 4, initialDelay: 1, maxDelay: 1 };

  it("retries UNAVAILABLE up to maxAttempts then rethrows the original ClientError", async () => {
    const counter = { count: 0 };
    const call = makeUnaryCall<string>(
      [
        new ClientError("/x", Status.UNAVAILABLE, "unavailable"),
        new ClientError("/x", Status.UNAVAILABLE, "unavailable"),
        new ClientError("/x", Status.UNAVAILABLE, "unavailable"),
        new ClientError("/x", Status.UNAVAILABLE, "unavailable"),
      ],
      counter
    );
    const mw = retryMiddleware(fastOpts);
    let caught: unknown;
    try {
      await consume(mw, call);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ClientError);
    expect((caught as ClientError).code).toBe(Status.UNAVAILABLE);
    expect(counter.count).toBe(4);
  });

  it("UNAVAILABLE followed by OK returns the OK response", async () => {
    const counter = { count: 0 };
    const call = makeUnaryCall<string>(
      [new ClientError("/x", Status.UNAVAILABLE, "unavailable"), "hello"],
      counter
    );
    const mw = retryMiddleware(fastOpts);
    const result = await consume(mw, call);
    expect(result).toBe("hello");
    expect(counter.count).toBe(2);
  });

  it("UNAVAILABLE followed by INVALID_ARGUMENT rethrows the typed error", async () => {
    const counter = { count: 0 };
    const call = makeUnaryCall<string>(
      [
        new ClientError("/x", Status.UNAVAILABLE, "unavailable"),
        new ClientError("/x", Status.INVALID_ARGUMENT, "invalid_blocks"),
      ],
      counter
    );
    const mw = retryMiddleware(fastOpts);
    let caught: unknown;
    try {
      await consume(mw, call);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ClientError);
    expect((caught as ClientError).code).toBe(Status.INVALID_ARGUMENT);
    expect((caught as ClientError).details).toBe("invalid_blocks");
    expect(counter.count).toBe(2);
  });

  it("does not retry typed errors — INVALID_ARGUMENT short-circuits on the first attempt", async () => {
    const counter = { count: 0 };
    const call = makeUnaryCall<string>(
      [
        new ClientError("/x", Status.INVALID_ARGUMENT, "bad"),
        // sentinel — must never be reached
        "should-not-reach",
      ],
      counter
    );
    const mw = retryMiddleware(fastOpts);
    let caught: unknown;
    try {
      await consume(mw, call);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ClientError);
    expect((caught as ClientError).code).toBe(Status.INVALID_ARGUMENT);
    expect(counter.count).toBe(1);
  });

  it("retries DEADLINE_EXCEEDED", async () => {
    const counter = { count: 0 };
    const call = makeUnaryCall<string>(
      [new ClientError("/x", Status.DEADLINE_EXCEEDED, "slow"), "ok"],
      counter
    );
    const mw = retryMiddleware(fastOpts);
    const result = await consume(mw, call);
    expect(result).toBe("ok");
    expect(counter.count).toBe(2);
  });

  it("server-set x-retryable: true triggers retry on otherwise-non-retriable codes (regression guard for opt-in path)", async () => {
    const counter = { count: 0 };
    const call = makeUnaryCall<string>(
      [
        clientErrorWithMetadata(Status.INTERNAL, "transient", {
          "x-retryable": "true",
        }),
        "ok",
      ],
      counter
    );
    const mw = retryMiddleware(fastOpts);
    const result = await consume(mw, call);
    expect(result).toBe("ok");
    expect(counter.count).toBe(2);
  });

  it("aborted signal short-circuits between attempts", async () => {
    const counter = { count: 0 };
    const ac = new AbortController();
    ac.abort();
    const call = makeUnaryCall<string>(
      [
        new ClientError("/x", Status.UNAVAILABLE, "unavailable"),
        // sentinel — must never be reached because we abort before retry
        "should-not-reach",
      ],
      counter
    );
    const mw = retryMiddleware(fastOpts);
    let caught: unknown;
    try {
      await consume(mw, call, { signal: ac.signal });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ClientError);
    expect((caught as ClientError).code).toBe(Status.UNAVAILABLE);
    expect(counter.count).toBe(1);
  });
});
