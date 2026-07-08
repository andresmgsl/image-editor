#!/usr/bin/env node
// One-time helper: obtain a Gmail OAuth 2.0 refresh token for the mailbox.
//
// Usage:
//   node scripts/get-refresh-token.mjs path/to/oauth-client.json
//   node scripts/get-refresh-token.mjs            # reads client id/secret from env
//
// It opens a consent URL, you sign in AS the mailbox account (e.g.
// ediciones@lafamilia.so) and approve, then it prints the refresh token to
// paste into .env as GOOGLE_OAUTH_REFRESH_TOKEN.
//
// Requires the OAuth client to be a "Desktop app" type (loopback redirect).

import http from "node:http";
import { readFileSync } from "node:fs";
import { google } from "googleapis";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
];
const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

function loadClient() {
  const file = process.argv[2];
  if (file) {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const c = parsed.installed ?? parsed.web ?? parsed;
    if (!c.client_id || !c.client_secret) {
      throw new Error(`${file} has no client_id/client_secret (is it an OAuth Client ID JSON?)`);
    }
    return { clientId: c.client_id, clientSecret: c.client_secret };
  }
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "Pass the OAuth client JSON path, or set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET",
    );
  }
  return { clientId, clientSecret };
}

const { clientId, clientSecret } = loadClient();
const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

const authUrl = oauth2.generateAuthUrl({
  access_type: "offline",
  prompt: "consent", // force a refresh_token even if previously granted
  scope: SCOPES,
});

const code = await new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      if (url.pathname !== "/oauth2callback") {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get("error");
      const c = url.searchParams.get("code");
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(err ? `Auth failed: ${err}. You can close this tab.` : "Done. You can close this tab.");
      server.close();
      if (err) reject(new Error(err));
      else resolve(c);
    } catch (e) {
      reject(e);
    }
  });
  server.listen(PORT, () => {
    console.log("\n1. Open this URL in your browser and sign in AS the mailbox account:\n");
    console.log(`   ${authUrl}\n`);
    console.log(`2. Waiting for the redirect on ${REDIRECT_URI} ...\n`);
  });
});

const { tokens } = await oauth2.getToken(code);
if (!tokens.refresh_token) {
  console.error(
    "\nNo refresh_token returned. Revoke prior access at " +
      "https://myaccount.google.com/permissions and re-run (prompt=consent is already set).",
  );
  process.exit(1);
}

console.log("\n✅ Success. Add this line to your .env (and the Coolify env vars):\n");
console.log(`GOOGLE_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}\n`);
