import type { AppConfig } from "./config.js";

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/**
 * Validate and extract the OAuth 2.0 credentials for the Gmail account. Pure
 * (no network / no construction) so it is unit-testable; index.ts passes the
 * result to `new google.auth.OAuth2(...)` + `setCredentials`.
 *
 * The service authenticates directly AS the mailbox via a long-lived refresh
 * token (obtained once with `scripts/get-refresh-token.mjs`) — no service
 * account, no domain-wide delegation.
 */
export function buildGmailOAuthConfig(config: AppConfig): OAuthConfig {
  const { oauthClientId, oauthClientSecret, oauthRefreshToken } = config.gmail;
  if (!oauthClientId) throw new Error("Missing Gmail OAuth client id");
  if (!oauthClientSecret) throw new Error("Missing Gmail OAuth client secret");
  if (!oauthRefreshToken) throw new Error("Missing Gmail OAuth refresh token");
  return { clientId: oauthClientId, clientSecret: oauthClientSecret, refreshToken: oauthRefreshToken };
}
