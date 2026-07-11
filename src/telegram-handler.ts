import { interpret, type AnthropicLike } from "./interpreter.js";
import { CATALOG, getModel, isValidChoice } from "./catalog.js";
import { isUserAllowed } from "./config.js";
import type { TgUpdate, TelegramApi } from "./telegram-client.js";
import type { PrefsStore } from "./telegram-prefs.js";

// Telegram caption limit, counted in UTF-16 code units.
// https://core.telegram.org/bots/api#sendphoto
const MAX_CAPTION_CHARS = 1024;
// Bot API getFile can only serve files up to 20 MB.
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

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

/** Truncate a caption to Telegram's limit without splitting a surrogate pair. */
export function truncateCaption(s: string): string {
  if (s.length <= MAX_CAPTION_CHARS) return s;
  let c = s.slice(0, MAX_CAPTION_CHARS);
  const last = c.charCodeAt(c.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) c = c.slice(0, -1); // don't leave a lone high surrogate
  return c;
}

type ImageSource =
  | { kind: "image"; fileId: string }
  | { kind: "too-large" }
  | { kind: "none" };

/**
 * Find the image the user wants edited. Telegram delivers a compressed picture
 * in `photo`, but "send as file" (full quality — common for an image team)
 * arrives as an image-mime `document`. Non-image documents are ignored here.
 */
function resolveImageSource(msg: NonNullable<TgUpdate["message"]>): ImageSource {
  if (msg.photo && msg.photo.length > 0) {
    return { kind: "image", fileId: msg.photo[msg.photo.length - 1].file_id };
  }
  const doc = msg.document;
  if (doc && (doc.mime_type ?? "").startsWith("image/")) {
    if ((doc.file_size ?? 0) > MAX_IMAGE_BYTES) return { kind: "too-large" };
    return { kind: "image", fileId: doc.file_id };
  }
  return { kind: "none" };
}

async function handleCommand(
  cmd: string,
  arg: string,
  userId: number,
  chatId: number,
  deps: HandlerDeps,
): Promise<void> {
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
        return deps.telegram.sendMessage(
          chatId,
          `Current model: ${cur}. Use /model <id> or /model auto. /models to list.`,
        );
      }
      const id = arg.toLowerCase();
      if (id === "auto") {
        deps.prefs.set(userId, null);
        return deps.telegram.sendMessage(chatId, "Model set to automatic.");
      }
      if (!getModel(id)) {
        return deps.telegram.sendMessage(chatId, `Unknown model "${arg}". Use /models to see valid ids.`);
      }
      deps.prefs.set(userId, id);
      return deps.telegram.sendMessage(chatId, `Model pinned to ${id}.`);
    }
    default:
      return deps.telegram.sendMessage(chatId, `Unknown command ${cmd}. /help for usage.`);
  }
}

export async function handleUpdate(update: TgUpdate, deps: HandlerDeps): Promise<void> {
  const msg = update.message;
  if (!msg || !msg.from) return; // ignore non-message updates (edited messages, channel posts, etc.)
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  if (!isUserAllowed(deps, userId)) {
    await deps.telegram.sendMessage(
      chatId,
      `Not authorized. Your Telegram ID is ${userId} — ask the admin to add you.`,
    );
    return;
  }

  const rawText = (msg.text ?? msg.caption ?? "").trim();
  if (rawText.startsWith("/")) {
    const [rawCmd, ...args] = rawText.split(/\s+/);
    const cmd = rawCmd.split("@")[0].toLowerCase(); // strip @botname (group chats), normalize case
    await handleCommand(cmd, args.join(" ").trim(), userId, chatId, deps);
    return;
  }

  const src = resolveImageSource(msg);
  if (src.kind === "too-large") {
    await deps.telegram.sendMessage(chatId, "That image is too large (max 20 MB). Please send a smaller version.");
    return;
  }
  const imageFileId = src.kind === "image" ? src.fileId : undefined;

  if (imageFileId && !rawText) {
    await deps.telegram.sendMessage(chatId, "Add a caption describing the edit.");
    return;
  }
  if (!imageFileId && !rawText) {
    // sticker / voice / empty message — nothing to interpret, don't spend a Claude call.
    await deps.telegram.sendMessage(chatId, HELP);
    return;
  }

  let decision;
  try {
    decision = await interpret(deps.anthropic, { text: rawText, hasImage: !!imageFileId });
  } catch (err) {
    console.error(`user=${userId} interpret failed:`, err);
    await deps.telegram.sendMessage(chatId, "Sorry — I couldn't understand that. Please rephrase and try again.");
    return;
  }

  if (decision.task === "clarify") {
    await deps.telegram.sendMessage(chatId, decision.message);
    return;
  }

  if (decision.task === "edit" && !imageFileId) {
    // Claude asked to edit but the user attached no image — guide them instead of 422-ing fal.
    await deps.telegram.sendMessage(
      chatId,
      "It looks like you want to edit an image, but none was attached — send the photo (or image file) with your instruction as its caption.",
    );
    return;
  }

  const pinned = deps.prefs.get(userId);
  let modelId = decision.modelId;
  let note = "";
  if (pinned) {
    if (isValidChoice(pinned, decision.task)) modelId = pinned;
    else note = ` (pinned ${pinned} can't ${decision.task} — used auto)`;
  }
  const model = getModel(modelId)!;

  const started = Date.now();
  const logSuffix = () =>
    `user=${userId} task=${decision.task} model=${model.id} pinned=${pinned ?? "auto"} ` +
    `prompt=${JSON.stringify(decision.prompt)}`;

  let image: Buffer;
  try {
    let inputImages: Buffer[] | undefined;
    if (decision.task === "edit" && imageFileId) {
      inputImages = [await deps.telegram.getFileBuffer(imageFileId)];
    }
    image = await deps.produceImage({
      endpoint: model.endpoint,
      prompt: decision.prompt,
      inputImages,
      imageInput: model.imageInput,
    });
  } catch (err) {
    console.error(`${logSuffix()} err ${((Date.now() - started) / 1000).toFixed(1)}s`, err);
    await deps.telegram.sendMessage(chatId, "Sorry — that request failed to generate. Please try again.");
    return;
  }

  const emoji = decision.task === "edit" ? "✏️" : "🎨";
  const caption = truncateCaption(`${emoji} ${model.label} · ${decision.prompt}${note}`);
  // Outside the try/catch above: a sendPhoto failure is not a "failed to generate" — the image
  // was already produced. Let it propagate to the caller (the loop logs it per-update).
  await deps.telegram.sendPhoto(chatId, image, caption);
  console.log(`${logSuffix()} ok ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
