/**
 * Persistent storage for per-team SubscribeEvents cursors.
 *
 * The default implementation is in-memory; callers wanting durability across
 * process restarts pass their own (filesystem, Redis, DB, etc.).
 *
 * `get` and `set` may be sync or async — slack-ts always awaits them.
 */
export interface CursorStore {
  get(teamId: string): Promise<string | undefined> | string | undefined;
  set(teamId: string, cursor: string): Promise<void> | void;
}

export function createInMemoryCursorStore(): CursorStore {
  const cursors = new Map<string, string>();
  return {
    get(teamId) {
      return cursors.get(teamId);
    },
    set(teamId, cursor) {
      cursors.set(teamId, cursor);
    },
  };
}
