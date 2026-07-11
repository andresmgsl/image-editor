import { interpret, type AnthropicLike } from "./interpreter.js";
import { CATALOG, getModel } from "./catalog.js";
import type { TgUpdate, TelegramApi } from "./telegram-client.js";
import type { PrefsStore } from "./telegram-prefs.js";

export interface ProduceImageArgs {
  endpoint: string;
  prompt: string;
  inputImages?: Buffer[];
  imageInput?: "image_url" | "image_urls";
}

export interface HandlerDeps {
  telegram: TelegramApi;
  anthropic: AnthropicLike;
  produceImage: (args: ProduceImageArgs) => Promise<Buffer>;
  allowlist: number[];
  prefs: PrefsStore;
}

const HELP =
  "Send a description to generate an image, or a photo with a caption to edit one. " +
  "/models to list models, /model <id> to pin one, /model auto for automatic.";

function modelsList(): string {
  return CATALOG.map((m) => `${m.id} — ${m.label} (${m.task}): ${m.description}`).join("\n");
}

async function handleCommand(cmd: string, arg: string, userId: number, chatId: number, deps: HandlerDeps): Promise<void> {
  switch (cmd) {
    case "/start":
    case "/help":
      return deps.telegram.sendMessage(chatId, HELP);
    case "/whoami":
      return deps.telegram.sendMessage(chatId, `Your Telegram ID is ${userId}.`);
    case "/models":
      return deps.telegram.sendMessage(chatId, modelsList());
    case "/model": {
      if (!arg) {
        const cur = deps.prefs.get(userId) ?? "auto";
        return deps.telegram.sendMessage(chatId, `Current model: ${cur}. Use /model <id> or /model auto. /models to list.`);
      }
      if (arg === "auto") {
        deps.prefs.set(userId, null);
        return deps.telegram.sendMessage(chatId, "Model set to automatic.");
      }
      if (!getModel(arg)) {
        return deps.telegram.sendMessage(chatId, `Unknown model "${arg}". Use /models to see valid ids.`);
      }
      deps.prefs.set(userId, arg);
      return deps.telegram.sendMessage(chatId, `Model pinned to ${arg}.`);
    }
    default:
      return deps.telegram.sendMessage(chatId, `Unknown command ${cmd}. /help for usage.`);
  }
}

export async function handleUpdate(update: TgUpdate, deps: HandlerDeps): Promise<void> {
  const msg = update.message;
  if (!msg || !msg.from) return; // ignore non-message updates
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  if (!deps.allowlist.includes(userId)) {
    await deps.telegram.sendMessage(chatId, `Not authorized. Your Telegram ID is ${userId} — ask the admin to add you.`);
    return;
  }

  const rawText = (msg.text ?? msg.caption ?? "").trim();
  if (rawText.startsWith("/")) {
    const [cmd, ...args] = rawText.split(/\s+/);
    await handleCommand(cmd, args.join(" ").trim(), userId, chatId, deps);
    return;
  }
  // Generation/edit path added in Task 5.
}
