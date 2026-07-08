import { describe, it, expect } from "vitest";
import { buildGmailOAuthConfig } from "../src/google-auth.js";
import type { AppConfig } from "../src/config.js";

function cfg(gmail: Partial<AppConfig["gmail"]>): AppConfig {
  return {
    anthropicApiKey: "a",
    falKey: "f",
    gmail: {
      user: "images@x.com",
      oauthClientId: "cid",
      oauthClientSecret: "secret",
      oauthRefreshToken: "1//rt",
      ...gmail,
    },
    allowlist: [],
    pollIntervalSeconds: 15,
  };
}

describe("buildGmailOAuthConfig", () => {
  it("returns the client id, secret, and refresh token from config", () => {
    const out = buildGmailOAuthConfig(cfg({}));
    expect(out).toEqual({ clientId: "cid", clientSecret: "secret", refreshToken: "1//rt" });
  });

  it("throws when the client id is empty", () => {
    expect(() => buildGmailOAuthConfig(cfg({ oauthClientId: "" }))).toThrow(/client id/i);
  });

  it("throws when the client secret is empty", () => {
    expect(() => buildGmailOAuthConfig(cfg({ oauthClientSecret: "" }))).toThrow(/client secret/i);
  });

  it("throws when the refresh token is empty", () => {
    expect(() => buildGmailOAuthConfig(cfg({ oauthRefreshToken: "" }))).toThrow(/refresh token/i);
  });
});
