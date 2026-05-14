import { describe, expect, it } from "bun:test";
import { createInMemoryCursorStore } from "../../src/types/cursor-store";

describe("createInMemoryCursorStore", () => {
  it("returns undefined for unknown teams", async () => {
    const store = createInMemoryCursorStore();
    expect(await store.get("T1")).toBeUndefined();
  });

  it("round-trips set/get", async () => {
    const store = createInMemoryCursorStore();
    await store.set("T1", "cursor-a");
    expect(await store.get("T1")).toBe("cursor-a");
  });

  it("isolates teams", async () => {
    const store = createInMemoryCursorStore();
    await store.set("T1", "a");
    await store.set("T2", "b");
    expect(await store.get("T1")).toBe("a");
    expect(await store.get("T2")).toBe("b");
  });

  it("overwrites on second set", async () => {
    const store = createInMemoryCursorStore();
    await store.set("T1", "a");
    await store.set("T1", "b");
    expect(await store.get("T1")).toBe("b");
  });
});
