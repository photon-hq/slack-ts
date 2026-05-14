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

  // Regression guard: auto-retrying UNAVAILABLE without server cooperation
  // caused duplicate writes (the response can be lost *after* the handler
  // already touched Slack — replay then double-executes non-idempotent ops
  // like chat.postMessage / reactions.add). The SDK only retries when the
  // server explicitly opts in via x-retryable: true.
  it("does NOT auto-retry UNAVAILABLE without x-retryable: true", async () => {
    const counter = { count: 0 };
    const call = makeUnaryCall<string>(
      [
        new ClientError("/x", Status.UNAVAILABLE, "unavailable"),
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
    expect((caught as ClientError).code).toBe(Status.UNAVAILABLE);
    expect(counter.count).toBe(1);
  });

  it("does NOT auto-retry DEADLINE_EXCEEDED without x-retryable: true", async () => {
    const counter = { count: 0 };
    const call = makeUnaryCall<string>(
      [
        new ClientError("/x", Status.DEADLINE_EXCEEDED, "slow"),
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
    expect((caught as ClientError).code).toBe(Status.DEADLINE_EXCEEDED);
    expect(counter.count).toBe(1);
  });

  it("does not retry typed errors — INVALID_ARGUMENT short-circuits on the first attempt", async () => {
    const counter = { count: 0 };
    const call = makeUnaryCall<string>(
      [
        new ClientError("/x", Status.INVALID_ARGUMENT, "bad"),
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

  it("retries when server attaches x-retryable: true (rate-limiter-style rejection)", async () => {
    const counter = { count: 0 };
    const call = makeUnaryCall<string>(
      [
        clientErrorWithMetadata(Status.UNAVAILABLE, "rate-limited", {
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

  it("retries x-retryable: true up to maxAttempts then rethrows the original ClientError", async () => {
    const counter = { count: 0 };
    const call = makeUnaryCall<string>(
      [
        clientErrorWithMetadata(Status.UNAVAILABLE, "rate-limited", {
          "x-retryable": "true",
        }),
        clientErrorWithMetadata(Status.UNAVAILABLE, "rate-limited", {
          "x-retryable": "true",
        }),
        clientErrorWithMetadata(Status.UNAVAILABLE, "rate-limited", {
          "x-retryable": "true",
        }),
        clientErrorWithMetadata(Status.UNAVAILABLE, "rate-limited", {
          "x-retryable": "true",
        }),
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

  it("server-set x-retryable: true triggers retry on otherwise-non-retriable codes", async () => {
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
        clientErrorWithMetadata(Status.UNAVAILABLE, "rate-limited", {
          "x-retryable": "true",
        }),
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
