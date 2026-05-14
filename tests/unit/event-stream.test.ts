import { describe, expect, it } from "bun:test";
import { TypedEventStream } from "../../src/streaming/event-stream";

const ALREADY_HAS_CONSUMER_RE = /already has a consumer/;

async function* fromArray<T>(items: readonly T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

describe("TypedEventStream", () => {
  it("iterates events with for await", async () => {
    const stream = new TypedEventStream(fromArray([1, 2, 3]));
    const result: number[] = [];
    for await (const ev of stream) {
      result.push(ev);
    }
    expect(result).toEqual([1, 2, 3]);
  });

  it("supports .map operator", async () => {
    const stream = new TypedEventStream(fromArray([1, 2, 3]));
    const result: number[] = [];
    for await (const v of stream.map((x) => x * 10)) {
      result.push(v);
    }
    expect(result).toEqual([10, 20, 30]);
  });

  it("supports .filter operator", async () => {
    const stream = new TypedEventStream(fromArray([1, 2, 3, 4]));
    const result: number[] = [];
    for await (const v of stream.filter((x) => x % 2 === 0)) {
      result.push(v);
    }
    expect(result).toEqual([2, 4]);
  });

  it("supports .take operator", async () => {
    const stream = new TypedEventStream(fromArray([1, 2, 3, 4, 5]));
    const result: number[] = [];
    for await (const v of stream.take(2)) {
      result.push(v);
    }
    expect(result).toEqual([1, 2]);
  });

  it("rejects a second consumer", () => {
    const stream = new TypedEventStream(fromArray([1, 2]));
    const iter = stream[Symbol.asyncIterator]();
    expect(iter).toBeDefined();
    expect(() => stream[Symbol.asyncIterator]()).toThrow(
      ALREADY_HAS_CONSUMER_RE
    );
  });

  it("supports asyncDispose", async () => {
    let closed = false;
    const stream = new TypedEventStream(fromArray([1, 2]), async () => {
      closed = true;
    });
    await stream[Symbol.asyncDispose]();
    expect(closed).toBe(true);
  });
});
