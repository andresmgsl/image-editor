import type { AppConfig } from "./config.js";

export interface JwtOptions {
  email?: string;
  key?: string;
  keyFile?: string;
  scopes: string[];
  subject: string;
}

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
];

/**
 * Build the options for a Google service-account JWT that impersonates the
 * inbox. Pure (no network / no construction) so it is unit-testable; index.ts
 * passes the result to `new google.auth.JWT(...)`.
 */
export function buildGmailAuthOptions(config: AppConfig): JwtOptions {
  const { impersonatedUser, serviceAccountKey, serviceAccountKeyFile } = config.gmail;
  if (serviceAccountKey) {
    let parsed: { client_email?: string; private_key?: string };
    try {
      parsed = JSON.parse(serviceAccountKey) as { client_email?: string; private_key?: string };
    } catch {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON (paste the full service-account key JSON)");
    }
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY JSON must contain client_email and private_key");
    }
    return { email: parsed.client_email, key: parsed.private_key, scopes: GMAIL_SCOPES, subject: impersonatedUser };
  }
  return { keyFile: serviceAccountKeyFile, scopes: GMAIL_SCOPES, subject: impersonatedUser };
}
