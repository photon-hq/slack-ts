/**
 * Credential abstraction consumed by `createClient`.
 *
 * The SDK takes JWTs from any `TokenProvider`. `staticTokens` (a fixed
 * `team_id → JWT` map) ships in the box. Implement this interface directly
 * to plug in a different token source.
 */

export interface TokenProvider {
  /**
   * Resolve a usable JWT for the given Slack team. Implementations may cache
   * and refresh internally; the caller awaits without knowing.
   */
  getAccessToken(teamId: string): Promise<string>;

  /**
   * Force-invalidate any cached token for the given team. Called by the
   * auth middleware on UNAUTHENTICATED so the next attempt re-mints.
   *
   * Implementations that issue per-project (rather than per-team) tokens may
   * choose to drop all cached entries when invalidated.
   */
  invalidate(teamId: string): void;

  /**
   * Optional discovery hook — returns the set of teams the provider knows
   * about, keyed by team_id. Used by `client.teams()`.
   */
  listTeams?(): Promise<ReadonlyMap<string, TeamMetadata>>;
}

export interface TeamMetadata {
  readonly appId: string;
  readonly botUserId: string;
  readonly grantedScopes: readonly string[];
  readonly teamName: string;
}
