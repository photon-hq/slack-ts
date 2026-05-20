/**
 * Identity types — see `MessagesResource.whoAmI()`.
 */

export interface WhoAmIResult {
  /** Slack `api_app_id` for the installed app. */
  readonly appId: string;
  /** Slack bot user id (e.g. `U0123456789`) for this installation. */
  readonly botUserId: string;
  /** Echoes the team_id this call was authorized against. */
  readonly teamId: string;
}
