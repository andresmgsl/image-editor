export interface AppConfig {
  anthropicApiKey: string;
  falKey: string;
  imap: { host: string; user: string; password: string };
  smtp: { host: string; user: string; password: string };
  allowlist: string[];
  pollIntervalSeconds: number;
}

function req(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  return {
    anthropicApiKey: req(env, "ANTHROPIC_API_KEY"),
    falKey: req(env, "FAL_KEY"),
    imap: { host: req(env, "IMAP_HOST"), user: req(env, "IMAP_USER"), password: req(env, "IMAP_PASSWORD") },
    smtp: { host: req(env, "SMTP_HOST"), user: req(env, "SMTP_USER"), password: req(env, "SMTP_PASSWORD") },
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
