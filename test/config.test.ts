import { describe, it, expect } from "vitest";
import { loadConfig, isAllowed } from "../src/config.js";

const base = {
  ANTHROPIC_API_KEY: "a", FAL_KEY: "f",
  GMAIL_IMPERSONATED_USER: "images@lafamilia.so",
  GOOGLE_SERVICE_ACCOUNT_KEY_FILE: "/keys/sa.json",
  ALLOWLIST: "Alice@Example.com, bob@example.com",
};

describe("loadConfig", () => {
  it("parses gmail config, allowlist (lowercased), and default poll interval", () => {
    const c = loadConfig(base as NodeJS.ProcessEnv);
    expect(c.anthropicApiKey).toBe("a");
    expect(c.gmail.impersonatedUser).toBe("images@lafamilia.so");
    expect(c.gmail.serviceAccountKeyFile).toBe("/keys/sa.json");
    expect(c.allowlist).toEqual(["alice@example.com", "bob@example.com"]);
    expect(c.pollIntervalSeconds).toBe(15);
  });

  it("falls back to 15 when POLL_INTERVAL_SECONDS is non-numeric", () => {
    const c = loadConfig({ ...base, POLL_INTERVAL_SECONDS: "abc" } as NodeJS.ProcessEnv);
    expect(c.pollIntervalSeconds).toBe(15);
  });

  it("uses a valid POLL_INTERVAL_SECONDS override", () => {
    const c = loadConfig({ ...base, POLL_INTERVAL_SECONDS: "30" } as NodeJS.ProcessEnv);
    expect(c.pollIntervalSeconds).toBe(30);
  });

  it("throws on a missing required var", () => {
    const { GMAIL_IMPERSONATED_USER, ...rest } = base;
    expect(() => loadConfig(rest as NodeJS.ProcessEnv)).toThrow(/GMAIL_IMPERSONATED_USER/);
  });

  it("accepts an inline service-account key instead of a file", () => {
    const { GOOGLE_SERVICE_ACCOUNT_KEY_FILE, ...rest } = base;
    const c = loadConfig({ ...rest, GOOGLE_SERVICE_ACCOUNT_KEY: '{"client_email":"x","private_key":"y"}' } as NodeJS.ProcessEnv);
    expect(c.gmail.serviceAccountKey).toBe('{"client_email":"x","private_key":"y"}');
    expect(c.gmail.serviceAccountKeyFile).toBeUndefined();
  });

  it("throws when neither SA-key var is set", () => {
    const { GOOGLE_SERVICE_ACCOUNT_KEY_FILE, ...rest } = base;
    expect(() => loadConfig(rest as NodeJS.ProcessEnv)).toThrow(/GOOGLE_SERVICE_ACCOUNT_KEY/);
  });

  it("throws when both SA-key vars are set", () => {
    expect(() =>
      loadConfig({ ...base, GOOGLE_SERVICE_ACCOUNT_KEY: '{"client_email":"x","private_key":"y"}' } as NodeJS.ProcessEnv),
    ).toThrow(/only one/);
  });
});

describe("isAllowed", () => {
  it("matches case-insensitively and rejects others", () => {
    const c = loadConfig(base as NodeJS.ProcessEnv);
    expect(isAllowed(c, "ALICE@example.com")).toBe(true);
    expect(isAllowed(c, "stranger@evil.com")).toBe(false);
  });
});
