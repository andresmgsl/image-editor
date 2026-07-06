import { describe, it, expect } from "vitest";
import { buildGmailAuthOptions } from "../src/google-auth.js";
import type { AppConfig } from "../src/config.js";

function cfg(gmail: AppConfig["gmail"]): AppConfig {
  return { anthropicApiKey: "a", falKey: "f", gmail, allowlist: [], pollIntervalSeconds: 15 };
}

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
];

describe("buildGmailAuthOptions", () => {
  it("builds inline-key options from GOOGLE_SERVICE_ACCOUNT_KEY JSON", () => {
    const key = JSON.stringify({ client_email: "sa@proj.iam", private_key: "PK", extra: 1 });
    const opts = buildGmailAuthOptions(cfg({ impersonatedUser: "images@x.com", serviceAccountKey: key }));
    expect(opts).toEqual({ email: "sa@proj.iam", key: "PK", scopes: SCOPES, subject: "images@x.com" });
  });

  it("builds keyFile options when only the file path is set", () => {
    const opts = buildGmailAuthOptions(cfg({ impersonatedUser: "images@x.com", serviceAccountKeyFile: "/k.json" }));
    expect(opts).toEqual({ keyFile: "/k.json", scopes: SCOPES, subject: "images@x.com" });
  });

  it("throws when the inline JSON lacks client_email or private_key", () => {
    const bad = JSON.stringify({ client_email: "sa@proj.iam" });
    expect(() => buildGmailAuthOptions(cfg({ impersonatedUser: "u", serviceAccountKey: bad }))).toThrow(
      /client_email and private_key/,
    );
  });

  it("throws a clear error when the inline key is not valid JSON", () => {
    expect(() => buildGmailAuthOptions(cfg({ impersonatedUser: "u", serviceAccountKey: "not-json{" }))).toThrow(
      /not valid JSON/,
    );
  });
});
