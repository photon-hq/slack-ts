import { describe, expect, it } from "bun:test";
import { fetchAllMissed } from "../../src/resources/events";
import type { MessageServiceClient } from "../../src/transport/grpc-client";

interface PageRequest {
  readonly cursor: string;
  readonly limit: number;
}

interface PageResponse {
  readonly events: ReadonlyArray<{
    readonly cursor: string;
    readonly user: string;
  }>;
  readonly hasMore: boolean;
}

/**
 * Build a mock MessageServiceClient that returns pre-canned pages keyed by
 * incoming cursor. Records each request for assertion.
 */
function mockClient(
  pages: ReadonlyMap<string, PageResponse>,
  requests: PageRequest[]
): MessageServiceClient {
  const fetchMissedEvents = (req: {
    readonly cursor?: { readonly opaque: string };
    readonly limit: number;
  }) => {
    const incoming = req.cursor?.opaque ?? "";
    requests.push({ cursor: incoming, limit: req.limit });
    const page = pages.get(incoming);
    if (!page) {
      throw new Error(`mock: no page for cursor=${incoming}`);
    }
    return Promise.resolve({
      events: page.events.map((e) => ({
        cursor: { opaque: e.cursor },
        message: {
          channel: "C1",
          user: e.user,
          text: "",
          ts: "1.0",
          files: [],
        },
      })),
      hasMore: page.hasMore,
    });
  };

  // Cast through unknown: we only exercise `fetchMissedEvents`.
  return { fetchMissedEvents } as unknown as MessageServiceClient;
}

describe("fetchAllMissed pagination", () => {
  it("returns events from a single page when hasMore is false", async () => {
    const requests: PageRequest[] = [];
    const client = mockClient(
      new Map([
        [
          "c0",
          {
            events: [
              { cursor: "c1", user: "U1" },
              { cursor: "c2", user: "U2" },
            ],
            hasMore: false,
          },
        ],
      ]),
      requests
    );

    const all = await fetchAllMissed(client, "T1", "c0");
    expect(all).toHaveLength(2);
    expect(all[0]?.cursor).toBe("c1");
    expect(all[1]?.cursor).toBe("c2");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.cursor).toBe("c0");
  });

  it("follows hasMore across pages, advancing the cursor", async () => {
    const requests: PageRequest[] = [];
    const client = mockClient(
      new Map([
        [
          "c0",
          {
            events: [
              { cursor: "c1", user: "U1" },
              { cursor: "c2", user: "U2" },
            ],
            hasMore: true,
          },
        ],
        [
          "c2",
          {
            events: [{ cursor: "c3", user: "U3" }],
            hasMore: false,
          },
        ],
      ]),
      requests
    );

    const all = await fetchAllMissed(client, "T1", "c0");
    expect(all.map((e) => e.cursor)).toEqual(["c1", "c2", "c3"]);
    expect(requests.map((r) => r.cursor)).toEqual(["c0", "c2"]);
  });

  it("terminates on an empty page even if hasMore is true (defensive)", async () => {
    const requests: PageRequest[] = [];
    const client = mockClient(
      new Map([
        [
          "c0",
          {
            events: [],
            hasMore: true, // server lied; our loop must still exit
          },
        ],
      ]),
      requests
    );

    const all = await fetchAllMissed(client, "T1", "c0");
    expect(all).toEqual([]);
    expect(requests).toHaveLength(1);
  });
});
