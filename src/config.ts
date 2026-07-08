export interface AppConfig {
  anthropicApiKey: string;
  falKey: string;
  gmail: { user: string; oauthClientId: string; oauthClientSecret: string; oauthRefreshToken: string };
  allowlist: string[];
  pollIntervalSeconds: number;
}

function req(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function loadGmailConfig(env: NodeJS.ProcessEnv): AppConfig["gmail"] {
  return {
    user: req(env, "GMAIL_USER"),
    oauthClientId: req(env, "GOOGLE_OAUTH_CLIENT_ID"),
    oauthClientSecret: req(env, "GOOGLE_OAUTH_CLIENT_SECRET"),
    oauthRefreshToken: req(env, "GOOGLE_OAUTH_REFRESH_TOKEN"),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  return {
    anthropicApiKey: req(env, "ANTHROPIC_API_KEY"),
    falKey: req(env, "FAL_KEY"),
    gmail: loadGmailConfig(env),
    allowlist: (env.ALLOWLIST ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    pollIntervalSeconds: parsePollInterval(env.POLL_INTERVAL_SECONDS),
  };
}

function parsePollInterval(raw: string | undefined): number {
  if (!raw) return 15;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 15;
}

export function isAllowed(config: AppConfig, sender: string): boolean {
  return config.allowlist.includes(sender.trim().toLowerCase());
}
