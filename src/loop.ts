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
      console.error(`[msg ${email.id}] unhandled error:`, err);
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
      console.error("Poll cycle failed; will retry next interval:", err);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
