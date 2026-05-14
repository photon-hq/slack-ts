/**
 * Default `TokenProvider` implementation: mints JWTs via spectrum-cloud's
 * `POST /projects/:projectId/slack/tokens` endpoint.
 *
 * Behavior:
 *
 * - Lazy mint on first `getAccessToken`.
 * - Caches tokens until 60s before `expiresIn`. Schedules a background refresh
 *   at that boundary so the next call doesn't pay HTTP latency.
 * - Concurrent `getAccessToken` calls during an in-flight mint share one HTTP
 *   request (coalesced via a single inflight promise).
 * - `invalidate(teamId)` clears the *entire* cache. spectrum-cloud currently
 *   issues one shared JWT per project — invalidating one team forces a
 *   re-mint that affects all of them. If cloud ever moves to per-team
 *   subjects, only this method needs updating.
 */

import {
  fromCloudNetworkError,
  fromCloudResponse,
} from "../errors/error-handler";
import { NotFoundError, type SlackErrorOptions } from "../errors/slack-error";
import { ErrorCode } from "../types/errors";
import { base64BasicAuth } from "../utils/base64";
import type { TeamMetadata, TokenProvider } from "./token-provider";

const DEFAULT_ENDPOINT = "https://cloud.spectrum.photon.codes";
const REFRESH_LEAD_MS = 60_000;
const TRAILING_SLASH_RE = /\/+$/;

interface CacheEntry {
  readonly expiresAt: number;
  readonly teams: Map<string, TeamMetadata>;
  readonly tokens: Map<string, string>;
}

interface MintResponseBody {
  readonly code?: string;
  readonly data?: {
    readonly auth: Record<string, string>;
    readonly teams: Record<
      string,
      {
        readonly teamName?: string;
        readonly botUserId?: string;
        readonly appId?: string;
        readonly grantedScopes?: readonly string[];
      }
    >;
    readonly expiresIn: number;
  };
  readonly message?: string;
  readonly succeed: boolean;
}

export interface SpectrumCloudTokenProviderOptions {
  /** Override the base URL of spectrum-cloud (e.g. for local dev). */
  readonly endpoint?: string;
  /** Override the global `fetch` (mostly for testing). */
  readonly fetch?: typeof fetch;
  readonly projectId: string;
  readonly projectSecret: string;
}

export class SpectrumCloudTokenProvider implements TokenProvider {
  private readonly projectId: string;
  private readonly projectSecret: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  private cache: CacheEntry | null = null;
  private inflight: Promise<CacheEntry> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: SpectrumCloudTokenProviderOptions) {
    this.projectId = options.projectId;
    this.projectSecret = options.projectSecret;
    this.endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(
      TRAILING_SLASH_RE,
      ""
    );
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async getAccessToken(teamId: string): Promise<string> {
    const cache = await this.ensureFresh();
    const token = cache.tokens.get(teamId);
    if (token === undefined) {
      throw new NotFoundError(`no installation for team_id=${teamId}`, {
        code: ErrorCode.notFound,
        retryable: false,
        grpcCode: 5, // NOT_FOUND
        context: {
          source: "spectrum-cloud",
          teamId,
        },
      } satisfies SlackErrorOptions);
    }
    return token;
  }

  invalidate(_teamId: string): void {
    this.cache = null;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  async listTeams(): Promise<ReadonlyMap<string, TeamMetadata>> {
    const cache = await this.ensureFresh();
    return cache.teams;
  }

  /** Stop the background refresh timer so the process can exit cleanly. */
  close(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private async ensureFresh(): Promise<CacheEntry> {
    const now = Date.now();
    if (this.cache && now < this.cache.expiresAt - REFRESH_LEAD_MS) {
      return this.cache;
    }
    if (!this.inflight) {
      this.inflight = this.mint().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async mint(): Promise<CacheEntry> {
    const url = `${this.endpoint}/projects/${encodeURIComponent(this.projectId)}/slack/tokens`;
    const auth = base64BasicAuth(this.projectId, this.projectSecret);

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
        },
      });
    } catch (err) {
      throw fromCloudNetworkError(err);
    }

    let body: MintResponseBody | undefined;
    try {
      body = (await res.json()) as MintResponseBody;
    } catch {
      body = undefined;
    }

    if (!(res.ok && body?.succeed && body.data)) {
      throw fromCloudResponse(res, body);
    }

    const tokens = new Map<string, string>();
    for (const [teamId, jwt] of Object.entries(body.data.auth)) {
      tokens.set(teamId, jwt);
    }

    const teams = new Map<string, TeamMetadata>();
    for (const [teamId, meta] of Object.entries(body.data.teams)) {
      teams.set(teamId, {
        teamName: meta.teamName ?? "",
        botUserId: meta.botUserId ?? "",
        appId: meta.appId ?? "",
        grantedScopes: meta.grantedScopes ?? [],
      });
    }

    const expiresAt = Date.now() + body.data.expiresIn * 1000;
    const entry: CacheEntry = { tokens, teams, expiresAt };
    this.cache = entry;
    this.scheduleRefresh(expiresAt);
    return entry;
  }

  private scheduleRefresh(expiresAt: number): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    const delay = Math.max(0, expiresAt - Date.now() - REFRESH_LEAD_MS);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      // Fire and forget — errors are swallowed because the next
      // `getAccessToken` will surface them properly.
      this.mint().catch(() => {
        // Don't keep retrying in the background; the caller's next request
        // will trigger another mint attempt.
      });
    }, delay);
    // Don't keep the event loop alive for refresh — exit cleanly when no
    // other handles remain.
    (this.refreshTimer as { unref?: () => void }).unref?.();
  }
}
