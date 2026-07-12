import { interpret, InterpreterUnavailableError, type AnthropicLike } from "./interpreter.js";
import { CATALOG, getModel, isValidChoice, type CatalogModel } from "./catalog.js";
import { isUserAllowed } from "./config.js";
import { resolveGeneration } from "./reference-routing.js";
import type { TgUpdate, TelegramApi } from "./telegram-client.js";
import type { PrefsStore } from "./telegram-prefs.js";
import type { ReferenceLibrary } from "./reference-library.js";

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
  library: ReferenceLibrary;
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
    const largest = msg.photo[msg.photo.length - 1];
    if ((largest.file_size ?? 0) > MAX_IMAGE_BYTES) return { kind: "too-large" };
    return { kind: "image", fileId: largest.file_id };
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
    decision = await interpret(deps.anthropic, {
      text: rawText,
      hasImage: !!imageFileId,
      library: deps.library.entries,
    });
  } catch (err) {
    console.error(`user=${userId} interpret failed:`, err);
    const message =
      err instanceof InterpreterUnavailableError
        ? "The image service is temporarily unavailable — please try again in a minute."
        : "Sorry — I couldn't understand that. Please rephrase and try again.";
    await deps.telegram.sendMessage(chatId, message);
    return;
  }

  if (decision.task === "clarify") {
    await deps.telegram.sendMessage(chatId, decision.message);
    return;
  }

  // Gate on resolved images, not reference ids: an unknown/empty-library id
  // silently resolves to zero images, which would otherwise sail through and
  // 422 at fal with no image_url(s).
  const refImages = deps.library.resolveImages(decision.references);

  if (decision.task === "edit" && !imageFileId && refImages.length === 0) {
    // Claude asked to edit but there's no image to work with — no attachment
    // and no resolved reference — guide the user instead of 422-ing fal.
    await deps.telegram.sendMessage(
      chatId,
      "It looks like you want to edit an image, but none was attached — send the photo (or image file) with your instruction as its caption.",
    );
    return;
  }

  if (decision.references.length > 0 && refImages.length === 0 && !imageFileId) {
    // Named references were requested, none resolved, and there's no attached
    // image to fall back on — don't silently generate unrelated content.
    await deps.telegram.sendMessage(
      chatId,
      "I couldn't find the reference(s) you mentioned, so I didn't generate anything — check the name, or attach the image directly.",
    );
    return;
  }

  const pinned = deps.prefs.get(userId);
  let modelId = decision.modelId;
  let note = "";
  if (decision.references.length > 0 && refImages.length === 0) {
    // A user image is present, so the request is still satisfiable — proceed
    // with the attachment, but don't silently drop the unresolved reference.
    note += " (couldn't find the named reference — used your attached image)";
  }
  if (pinned) {
    if (isValidChoice(pinned, decision.task)) modelId = pinned;
    else note = ` (pinned ${pinned} can't ${decision.task} — used auto)`;
  }

  const started = Date.now();

  let image: Buffer;
  let model: CatalogModel;
  try {
    const userImages: Buffer[] = [];
    if (imageFileId) userImages.push(await deps.telegram.getFileBuffer(imageFileId));
    const resolved = resolveGeneration({ chosenModelId: modelId, userImages, refImages });
    model = resolved.model;
    note += resolved.overrideNote;
    if (resolved.droppedCount > 0) note += ` (capped at 8 images; dropped ${resolved.droppedCount})`;
    image = await deps.produceImage({
      endpoint: model.endpoint,
      prompt: decision.prompt,
      inputImages: resolved.images.length ? resolved.images : undefined,
      imageInput: model.imageInput,
    });
  } catch (err) {
    console.error(
      `user=${userId} task=${decision.task} pinned=${pinned ?? "auto"} err ` +
        `${((Date.now() - started) / 1000).toFixed(1)}s`,
      err,
    );
    await deps.telegram.sendMessage(chatId, "Sorry — that request failed to generate. Please try again.");
    return;
  }

  const emoji = decision.task === "edit" ? "✏️" : "🎨";
  const caption = truncateCaption(`${emoji} ${model.label} · ${decision.prompt}${note}`);
  try {
    await deps.telegram.sendPhoto(chatId, image, caption);
  } catch (err) {
    // Delivery failed after a paid, successful generation — don't go fully silent.
    // Try a different endpoint (sendMessage) once; if that also fails, the original
    // sendPhoto error still propagates so the loop logs it (intentionally NOT
    // mislabeled as a generation failure — see the regression test for that).
    try {
      await deps.telegram.sendMessage(
        chatId,
        "I generated your image but couldn't deliver it — please try again",
      );
    } catch {
      // fallback also failed; fall through to rethrow the original error below.
    }
    throw err;
  }
  console.log(
    `user=${userId} task=${decision.task} model=${model.id} pinned=${pinned ?? "auto"} ` +
      `refs=${JSON.stringify(decision.references)} ok ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
}
