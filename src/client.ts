import { SpectrumCloudTokenProvider } from "./auth/spectrum-cloud-token-provider";
import type { TeamMetadata, TokenProvider } from "./auth/token-provider";
import { EventsResource } from "./resources/events";
import { FilesResource } from "./resources/files";
import { MessagesResource } from "./resources/messages";
import {
  createSlackChannel,
  createTeamGrpcClients,
} from "./transport/grpc-client";
import type { ClientOptions } from "./types/client";
import { createInMemoryCursorStore } from "./types/cursor-store";

export interface SlackClient extends AsyncDisposable {
  close(): Promise<void>;
  /** Get the per-team scoped client (cached on first access). */
  team(teamId: string): TeamClient;
  /** Discover installed workspaces. Backed by the token provider's `listTeams`. */
  teams(): Promise<ReadonlyMap<string, TeamMetadata>>;
}

export interface TeamClient {
  readonly events: EventsResource;
  readonly files: FilesResource;
  readonly messages: MessagesResource;
  readonly teamId: string;
}

export function createClient(options: ClientOptions): SlackClient {
  const tokenProvider: TokenProvider =
    "tokenProvider" in options
      ? options.tokenProvider
      : new SpectrumCloudTokenProvider({
          projectId: options.projectId,
          projectSecret: options.projectSecret,
          endpoint: options.spectrumCloudEndpoint,
        });

  const channel = createSlackChannel({
    endpoint: options.spectrumSlackEndpoint,
  });
  const cursorStore = options.cursorStore ?? createInMemoryCursorStore();
  const teamClients = new Map<string, TeamClient>();

  const team = (teamId: string): TeamClient => {
    const cached = teamClients.get(teamId);
    if (cached) {
      return cached;
    }
    const grpc = createTeamGrpcClients({
      channel,
      tokenProvider,
      teamId,
      retry: options.retry,
      timeout: options.timeout,
    });
    const created: TeamClient = {
      teamId,
      messages: new MessagesResource(grpc.messages),
      events: new EventsResource(grpc.messages, {
        teamId,
        cursorStore,
        tokenProvider,
      }),
      files: new FilesResource(grpc.files),
    };
    teamClients.set(teamId, created);
    return created;
  };

  const teams = async (): Promise<ReadonlyMap<string, TeamMetadata>> => {
    if (!tokenProvider.listTeams) {
      return new Map();
    }
    return await tokenProvider.listTeams();
  };

  const close = async (): Promise<void> => {
    if (tokenProvider instanceof SpectrumCloudTokenProvider) {
      tokenProvider.close();
    }
    channel.close();
  };

  return {
    team,
    teams,
    close,
    [Symbol.asyncDispose]: close,
  };
}
