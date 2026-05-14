import { describe, expect, it } from "bun:test";
import { withResumableReconnect } from "../../src/streaming/reconnect";

describe("withResumableReconnect", () => {
  it("yields all events from a single successful stream", async () => {
    const stream = withResumableReconnect<number>(
      async function* createStream() {
        yield 1;
        yield 2;
        yield 3;
      },
      async () => [],
      () => undefined,
      { maxAttempts: 0 }
    );
    const result: number[] = [];
    for await (const v of stream) {
      result.push(v);
    }
    expect(result).toEqual([1, 2, 3]);
  });

  it("drains gap-fill before resuming live on reconnect", async () => {
    let createCount = 0;
    let cursor = "c0";

    const stream = withResumableReconnect<number>(
      async function* createStream() {
        createCount++;
        if (createCount === 1) {
          yield 1;
          cursor = "c1";
          throw new Error("boom");
        }
        yield 4;
        cursor = "c2";
      },
      async () => {
        // Gap-fill returns the missed events 2, 3.
        return [2, 3];
      },
      () => cursor,
      { initialDelay: 1, maxAttempts: 2 }
    );

    const result: number[] = [];
    for await (const v of stream) {
      result.push(v);
      if (result.length >= 4) {
        break;
      }
    }
    expect(result).toEqual([1, 2, 3, 4]);
    expect(createCount).toBe(2);
  });

  it("stops on shouldStop predicate without backoff", async () => {
    let attempts = 0;
    const SENTINEL = new Error("stop me");
    const stream = withResumableReconnect<number>(
      // biome-ignore lint/correctness/useYield: this generator intentionally throws before yielding
      async function* createStream() {
        attempts++;
        throw SENTINEL;
      },
      async () => [],
      () => undefined,
      {
        initialDelay: 50_000,
        maxAttempts: 5,
        shouldStop: (e) => e === SENTINEL,
      }
    );

    let caught: unknown;
    try {
      for await (const _ of stream) {
        // no-op
      }
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(SENTINEL);
    expect(attempts).toBe(1);
  });

  it("invokes onError on every caught stream failure", async () => {
    const errors: unknown[] = [];
    let attempts = 0;
    const stream = withResumableReconnect<number>(
      async function* createStream() {
        attempts++;
        if (attempts === 1) {
          throw new Error("first");
        }
        yield 1;
      },
      async () => [],
      () => undefined,
      {
        initialDelay: 1,
        maxAttempts: 2,
        onError: (e) => errors.push(e),
      }
    );

    for await (const _ of stream) {
      break;
    }
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("first");
  });
});
