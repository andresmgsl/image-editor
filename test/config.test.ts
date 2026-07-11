import { describe, it, expect } from "vitest";
import { loadConfig, isAllowed, loadTelegramConfig, isUserAllowed } from "../src/config.js";

const base = {
  ANTHROPIC_API_KEY: "a", FAL_KEY: "f",
  GMAIL_USER: "images@lafamilia.so",
  GOOGLE_OAUTH_CLIENT_ID: "cid.apps.googleusercontent.com",
  GOOGLE_OAUTH_CLIENT_SECRET: "csecret",
  GOOGLE_OAUTH_REFRESH_TOKEN: "1//refresh",
  ALLOWLIST: "Alice@Example.com, bob@example.com",
};

describe("loadConfig", () => {
  it("parses gmail OAuth config, allowlist (lowercased), and default poll interval", () => {
    const c = loadConfig(base as NodeJS.ProcessEnv);
    expect(c.anthropicApiKey).toBe("a");
    expect(c.gmail.user).toBe("images@lafamilia.so");
    expect(c.gmail.oauthClientId).toBe("cid.apps.googleusercontent.com");
    expect(c.gmail.oauthClientSecret).toBe("csecret");
    expect(c.gmail.oauthRefreshToken).toBe("1//refresh");
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

  it("throws on a missing GMAIL_USER", () => {
    const { GMAIL_USER, ...rest } = base;
    expect(() => loadConfig(rest as NodeJS.ProcessEnv)).toThrow(/GMAIL_USER/);
  });

  it("throws on a missing GOOGLE_OAUTH_CLIENT_ID", () => {
    const { GOOGLE_OAUTH_CLIENT_ID, ...rest } = base;
    expect(() => loadConfig(rest as NodeJS.ProcessEnv)).toThrow(/GOOGLE_OAUTH_CLIENT_ID/);
  });

  it("throws on a missing GOOGLE_OAUTH_CLIENT_SECRET", () => {
    const { GOOGLE_OAUTH_CLIENT_SECRET, ...rest } = base;
    expect(() => loadConfig(rest as NodeJS.ProcessEnv)).toThrow(/GOOGLE_OAUTH_CLIENT_SECRET/);
  });

  it("throws on a missing GOOGLE_OAUTH_REFRESH_TOKEN", () => {
    const { GOOGLE_OAUTH_REFRESH_TOKEN, ...rest } = base;
    expect(() => loadConfig(rest as NodeJS.ProcessEnv)).toThrow(/GOOGLE_OAUTH_REFRESH_TOKEN/);
  });
});

describe("isAllowed", () => {
  it("matches case-insensitively and rejects others", () => {
    const c = loadConfig(base as NodeJS.ProcessEnv);
    expect(isAllowed(c, "ALICE@example.com")).toBe(true);
    expect(isAllowed(c, "stranger@evil.com")).toBe(false);
  });
});

const tgBase = { ANTHROPIC_API_KEY: "a", FAL_KEY: "f", TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_ALLOWLIST: "111, 222" };

describe("loadTelegramConfig", () => {
  it("parses token, keys, and numeric allowlist", () => {
    const c = loadTelegramConfig(tgBase as unknown as NodeJS.ProcessEnv);
    expect(c.anthropicApiKey).toBe("a");
    expect(c.falKey).toBe("f");
    expect(c.botToken).toBe("123:abc");
    expect(c.allowlist).toEqual([111, 222]);
  });

  it("throws on a missing TELEGRAM_BOT_TOKEN", () => {
    const { TELEGRAM_BOT_TOKEN, ...rest } = tgBase;
    expect(() => loadTelegramConfig(rest as unknown as NodeJS.ProcessEnv)).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it("throws when the allowlist is empty", () => {
    expect(() => loadTelegramConfig({ ...tgBase, TELEGRAM_ALLOWLIST: "" } as unknown as NodeJS.ProcessEnv)).toThrow(/TELEGRAM_ALLOWLIST/);
  });

  it("throws on a non-numeric allowlist id", () => {
    expect(() => loadTelegramConfig({ ...tgBase, TELEGRAM_ALLOWLIST: "111, bob" } as unknown as NodeJS.ProcessEnv)).toThrow(/bob/);
  });
});

describe("isUserAllowed", () => {
  it("accepts listed ids and rejects others", () => {
    const c = loadTelegramConfig(tgBase as unknown as NodeJS.ProcessEnv);
    expect(isUserAllowed(c, 111)).toBe(true);
    expect(isUserAllowed(c, 999)).toBe(false);
  });
});
