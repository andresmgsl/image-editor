import { processEmail, type OrchestratorDeps } from "./orchestrator.js";
import type { IncomingEmail } from "./mailbox.js";

export interface LoopDeps extends OrchestratorDeps {
  mailbox: {
    fetchUnread(): Promise<IncomingEmail[]>;
    markSeen(uid: number): Promise<void>;
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
      await deps.mailbox.markSeen(email.uid);
      console.log(`[uid ${email.uid}] ${email.from} -> ${result}`);
    } catch (err) {
      console.error(`[uid ${email.uid}] unhandled error:`, err);
    }
  }
}

export async function runLoop(
  deps: LoopDeps,
  intervalMs: number,
  shouldStop: () => boolean,
): Promise<void> {
  while (!shouldStop()) {
    await runOnce(deps);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
