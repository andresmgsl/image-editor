import { handleUpdate, type HandlerDeps } from "./telegram-handler.js";
import type { TgUpdate } from "./telegram-client.js";

export async function runTelegramLoop(
  deps: HandlerDeps,
  shouldStop: () => boolean,
  pollTimeoutSeconds = 30,
  handle: typeof handleUpdate = handleUpdate,
): Promise<void> {
  let offset = 0;
  while (!shouldStop()) {
    let updates: TgUpdate[] = [];
    try {
      updates = await deps.telegram.getUpdates(offset, pollTimeoutSeconds);
    } catch (err) {
      console.error("getUpdates failed; retrying:", err);
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    for (const update of updates) {
      offset = Math.max(offset, update.update_id + 1);
      try {
        await handle(update, deps);
      } catch (err) {
        console.error(`update ${update.update_id} failed:`, err);
      }
    }
  }
}
