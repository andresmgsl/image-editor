import { handleUpdate, type HandlerDeps } from "./telegram-handler.js";
import { memoryOffsetStore, type OffsetStore } from "./telegram-offset.js";
import type { TgUpdate } from "./telegram-client.js";

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

export async function runTelegramLoop(
  deps: HandlerDeps,
  shouldStop: () => boolean,
  pollTimeoutSeconds = 30,
  handle: typeof handleUpdate = handleUpdate,
  offsetStore: OffsetStore = memoryOffsetStore(),
): Promise<void> {
  let offset = offsetStore.get();
  let backoff = INITIAL_BACKOFF_MS;
  while (!shouldStop()) {
    let updates: TgUpdate[];
    try {
      updates = await deps.telegram.getUpdates(offset, pollTimeoutSeconds);
      backoff = INITIAL_BACKOFF_MS; // reset after a successful poll
    } catch (err) {
      // Errors here are usually transient (network) or a 409 (another poller / a
      // stale webhook). Back off exponentially so we don't hot-loop at 1 Hz.
      console.error(`getUpdates failed; retrying in ${backoff}ms:`, err);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      continue;
    }
    for (const update of updates) {
      offset = Math.max(offset, update.update_id + 1);
      try {
        await handle(update, deps);
      } catch (err) {
        console.error(`update ${update.update_id} failed:`, err);
      }
      // Persist after each handled update (not just at batch end) so a crash/redeploy
      // resumes past exactly what was already handled, instead of re-delivering (and
      // re-billing Claude + fal for) the rest of the batch. A throwing update still
      // advances past itself here — it is not retried, matching prior semantics.
      offsetStore.set(offset);
    }
  }
}
