import { describe, expect, it } from "bun:test";
import { SpectrumCloudTokenProvider } from "../../src/auth/spectrum-cloud-token-provider";
import { staticTokens } from "../../src/auth/static-token-provider";
import {
  AuthenticationError,
  ConnectionError,
  PermissionError,
  RateLimitError,
} from "../../src/errors/slack-error";

const NO_INSTALLATION_RE = /no installation for team_id/;
const NO_TOKEN_CONFIGURED_RE = /no token configured/;

function mockOkResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function mockErrorResponse(
  status: number,
  body?: unknown,
  headers?: Record<string, string>
): Response {
  return new Response(body ? JSON.stringify(body) : null, {
    status,
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
  });
}

const mintBody = {
  succeed: true,
  data: {
    auth: { T1: "jwt-1", T2: "jwt-2" },
    teams: {
      T1: {
        teamName: "Acme",
        botUserId: "U-bot",
        appId: "A-app",
        grantedScopes: ["chat:write"],
      },
      T2: {
        teamName: "Other",
        botUserId: "U2",
        appId: "A2",
        grantedScopes: [],
      },
    },
    expiresIn: 900,
  },
};

describe("SpectrumCloudTokenProvider", () => {
  it("mints lazily on first getAccessToken", async () => {
    let calls = 0;
    const provider = new SpectrumCloudTokenProvider({
      projectId: "p",
      projectSecret: "s",
      endpoint: "http://cloud",
      fetch: async () => {
        calls++;
        return mockOkResponse(mintBody);
      },
    });
    expect(calls).toBe(0);
    const token = await provider.getAccessToken("T1");
    expect(token).toBe("jwt-1");
    expect(calls).toBe(1);
    provider.close();
  });

  it("coalesces concurrent getAccessToken calls into one HTTP request", async () => {
    let calls = 0;
    const provider = new SpectrumCloudTokenProvider({
      projectId: "p",
      projectSecret: "s",
      endpoint: "http://cloud",
      fetch: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        return mockOkResponse(mintBody);
      },
    });
    const results = await Promise.all([
      provider.getAccessToken("T1"),
      provider.getAccessToken("T2"),
      provider.getAccessToken("T1"),
    ]);
    expect(results).toEqual(["jwt-1", "jwt-2", "jwt-1"]);
    expect(calls).toBe(1);
    provider.close();
  });

  it("caches across subsequent calls within TTL", async () => {
    let calls = 0;
    const provider = new SpectrumCloudTokenProvider({
      projectId: "p",
      projectSecret: "s",
      endpoint: "http://cloud",
      fetch: async () => {
        calls++;
        return mockOkResponse(mintBody);
      },
    });
    await provider.getAccessToken("T1");
    await provider.getAccessToken("T2");
    await provider.getAccessToken("T1");
    expect(calls).toBe(1);
    provider.close();
  });

  it("invalidate clears the cache (all teams)", async () => {
    let calls = 0;
    const provider = new SpectrumCloudTokenProvider({
      projectId: "p",
      projectSecret: "s",
      endpoint: "http://cloud",
      fetch: async () => {
        calls++;
        return mockOkResponse(mintBody);
      },
    });
    await provider.getAccessToken("T1");
    expect(calls).toBe(1);
    provider.invalidate("T1");
    await provider.getAccessToken("T2");
    expect(calls).toBe(2);
    provider.close();
  });

  it("listTeams returns metadata after minting", async () => {
    const provider = new SpectrumCloudTokenProvider({
      projectId: "p",
      projectSecret: "s",
      endpoint: "http://cloud",
      fetch: async () => mockOkResponse(mintBody),
    });
    const teams = await provider.listTeams();
    expect(teams.size).toBe(2);
    expect(teams.get("T1")?.teamName).toBe("Acme");
    provider.close();
  });

  it("getAccessToken for an unknown team → NotFoundError", async () => {
    const provider = new SpectrumCloudTokenProvider({
      projectId: "p",
      projectSecret: "s",
      endpoint: "http://cloud",
      fetch: async () => mockOkResponse(mintBody),
    });
    await expect(provider.getAccessToken("T-NOPE")).rejects.toThrow(
      NO_INSTALLATION_RE
    );
    provider.close();
  });

  it("HTTP 401 → AuthenticationError", async () => {
    const provider = new SpectrumCloudTokenProvider({
      projectId: "p",
      projectSecret: "s",
      endpoint: "http://cloud",
      fetch: async () =>
        mockErrorResponse(401, { succeed: false, message: "bad creds" }),
    });
    await expect(provider.getAccessToken("T1")).rejects.toBeInstanceOf(
      AuthenticationError
    );
    provider.close();
  });

  it("HTTP 403 with platform_disabled → PermissionError(platform_disabled)", async () => {
    const provider = new SpectrumCloudTokenProvider({
      projectId: "p",
      projectSecret: "s",
      endpoint: "http://cloud",
      fetch: async () =>
        mockErrorResponse(403, {
          succeed: false,
          message: "platform_disabled: slack",
        }),
    });
    let caught: unknown;
    try {
      await provider.getAccessToken("T1");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PermissionError);
    expect((caught as PermissionError).permission.kind).toBe(
      "platform_disabled"
    );
    provider.close();
  });

  it("HTTP 429 with Retry-After → RateLimitError(retryAfterMs)", async () => {
    const provider = new SpectrumCloudTokenProvider({
      projectId: "p",
      projectSecret: "s",
      endpoint: "http://cloud",
      fetch: async () =>
        mockErrorResponse(429, { succeed: false }, { "Retry-After": "7" }),
    });
    let caught: unknown;
    try {
      await provider.getAccessToken("T1");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RateLimitError);
    expect((caught as RateLimitError).retryAfterMs).toBe(7000);
    provider.close();
  });

  it("Network failure → ConnectionError", async () => {
    const provider = new SpectrumCloudTokenProvider({
      projectId: "p",
      projectSecret: "s",
      endpoint: "http://cloud",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(provider.getAccessToken("T1")).rejects.toBeInstanceOf(
      ConnectionError
    );
    provider.close();
  });

  it("invalidate() during an in-flight mint forces a re-mint", async () => {
    // Two mints, distinguishable by the token value, so we can assert which
    // one ended up in the cache.
    let calls = 0;
    const responses = [
      { ...mintBody, data: { ...mintBody.data, auth: { T1: "jwt-A" } } },
      { ...mintBody, data: { ...mintBody.data, auth: { T1: "jwt-B" } } },
    ];

    // Gate the first fetch so we can interleave invalidate() before it
    // resolves.
    let releaseFirst: () => void = () => {
      // assigned below
    };
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const provider = new SpectrumCloudTokenProvider({
      projectId: "p",
      projectSecret: "s",
      endpoint: "http://cloud",
      fetch: async () => {
        const i = calls++;
        if (i === 0) {
          await firstReleased;
        }
        return mockOkResponse(responses[i]);
      },
    });

    // Kick off the first mint but don't await yet.
    const first = provider.getAccessToken("T1");
    // Yield once so ensureFresh has actually started the fetch.
    await Promise.resolve();

    // Invalidate while the first mint is still in flight.
    provider.invalidate("T1");

    // Let the first fetch resolve. Per the generation guard, its result
    // must NOT be written to cache.
    releaseFirst();

    // The first getAccessToken call will loop and re-mint, ending with jwt-B.
    expect(await first).toBe("jwt-B");
    // Subsequent calls hit the cache (jwt-B), no further fetches.
    expect(await provider.getAccessToken("T1")).toBe("jwt-B");
    expect(calls).toBe(2);
    provider.close();
  });
});

describe("staticTokens", () => {
  it("returns configured tokens", async () => {
    const tp = staticTokens({
      tokens: { T1: "jwt-1", T2: "jwt-2" },
      teams: {
        T1: { teamName: "X", botUserId: "U", appId: "A", grantedScopes: [] },
      },
    });
    expect(await tp.getAccessToken("T1")).toBe("jwt-1");
    expect((await tp.listTeams?.())?.get("T1")?.teamName).toBe("X");
  });

  it("rejects for unknown teams", async () => {
    const tp = staticTokens({ tokens: { T1: "jwt" } });
    await expect(tp.getAccessToken("T-NOPE")).rejects.toThrow(
      NO_TOKEN_CONFIGURED_RE
    );
  });

  it("invalidate is a no-op", () => {
    const tp = staticTokens({ tokens: { T1: "jwt" } });
    tp.invalidate("T1");
    // Still works.
    return expect(tp.getAccessToken("T1")).resolves.toBe("jwt");
  });
});
