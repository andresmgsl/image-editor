import { processEmail, type OrchestratorDeps } from "./orchestrator.js";
import type { IncomingEmail } from "./mailbox.js";

export interface LoopDeps extends OrchestratorDeps {
  mailbox: {
    fetchUnread(): Promise<IncomingEmail[]>;
    markRead(id: string): Promise<void>;
  };
}

export async function runOnce(
  deps: LoopDeps,
  process: typeof processEmail = processEmail,
): Promise<void> {
  const emails = await deps.mailbox.fetchUnread();
  for (const email of emails) {
    try {
      const result = await process(email, deps);
      await deps.mailbox.markRead(email.id);
      console.log(`[msg ${email.id}] ${email.from} -> ${result}`);
    } catch (err) {
      // Never log the raw error object: gaxios's redactor scrubs Authorization
      // headers and client_secret/grant_type body params, but NOT the OAuth
      // refresh_token body param, so a raw GaxiosError could leak the
      // mailbox's refresh token into logs. Log only the message.
      console.error(`[msg ${email.id}] unhandled error:`, err instanceof Error ? err.message : String(err));
    }
  }
}

export async function runLoop(
  deps: LoopDeps,
  intervalMs: number,
  shouldStop: () => boolean,
  once: (deps: LoopDeps) => Promise<void> = runOnce,
): Promise<void> {
  while (!shouldStop()) {
    try {
      await once(deps);
    } catch (err) {
      // See the note above: log only the message, never the raw error object.
      console.error("Poll cycle failed; will retry next interval:", err instanceof Error ? err.message : String(err));
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
