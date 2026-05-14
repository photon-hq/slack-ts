/**
 * `TokenProvider` backed by a fixed token map.
 *
 * Useful for tests and BYO scenarios where the caller mints JWTs out-of-band.
 * `invalidate` is a no-op — there's no way to refresh static tokens.
 */

import type { TeamMetadata, TokenProvider } from "./token-provider";

export interface StaticTokensOptions {
  /** Optional metadata returned by `listTeams()`. */
  readonly teams?: Readonly<Record<string, TeamMetadata>>;
  /** Map of team_id → JWT. */
  readonly tokens: Readonly<Record<string, string>>;
}

export function staticTokens(options: StaticTokensOptions): TokenProvider {
  const tokenMap = new Map(Object.entries(options.tokens));
  const teamMap = new Map<string, TeamMetadata>(
    options.teams ? Object.entries(options.teams) : []
  );

  return {
    getAccessToken(teamId: string): Promise<string> {
      const token = tokenMap.get(teamId);
      if (token === undefined) {
        return Promise.reject(
          new Error(`staticTokens: no token configured for team_id=${teamId}`)
        );
      }
      return Promise.resolve(token);
    },
    invalidate(_teamId: string): void {
      // No-op: static tokens cannot be refreshed.
    },
    listTeams(): Promise<ReadonlyMap<string, TeamMetadata>> {
      return Promise.resolve(teamMap);
    },
  };
}
