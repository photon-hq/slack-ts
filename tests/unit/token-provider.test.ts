import { describe, expect, it } from "bun:test";
import { staticTokens } from "../../src/auth/static-token-provider";

const NO_TOKEN_CONFIGURED_RE = /no token configured/;

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
