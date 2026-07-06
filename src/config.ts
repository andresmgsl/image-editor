export interface AppConfig {
  anthropicApiKey: string;
  falKey: string;
  gmail: { impersonatedUser: string; serviceAccountKey?: string; serviceAccountKeyFile?: string };
  allowlist: string[];
  pollIntervalSeconds: number;
}

function req(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function loadGmailConfig(env: NodeJS.ProcessEnv): AppConfig["gmail"] {
  const impersonatedUser = req(env, "GMAIL_IMPERSONATED_USER");
  const serviceAccountKey = env.GOOGLE_SERVICE_ACCOUNT_KEY?.trim() || undefined;
  const serviceAccountKeyFile = env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE?.trim() || undefined;
  if (!serviceAccountKey && !serviceAccountKeyFile) {
    throw new Error("Set GOOGLE_SERVICE_ACCOUNT_KEY (inline JSON) or GOOGLE_SERVICE_ACCOUNT_KEY_FILE (path)");
  }
  if (serviceAccountKey && serviceAccountKeyFile) {
    throw new Error("Set only one of GOOGLE_SERVICE_ACCOUNT_KEY or GOOGLE_SERVICE_ACCOUNT_KEY_FILE, not both");
  }
  return { impersonatedUser, serviceAccountKey, serviceAccountKeyFile };
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
