import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { fal } from "@fal-ai/client";
import { loadTelegramConfig } from "./config.js";
import { TelegramClient } from "./telegram-client.js";
import { loadPrefsStore } from "./telegram-prefs.js";
import { loadOffsetStore } from "./telegram-offset.js";
import { runModel, type FalLike } from "./fal-runner.js";
import { downloadImage, toLowRes } from "./image.js";
import { runTelegramLoop } from "./telegram-loop.js";
import { loadReferenceLibrary } from "./reference-library.js";

const config = loadTelegramConfig(process.env);
fal.config({ credentials: config.falKey });
const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
const telegram = new TelegramClient(config.botToken);
const prefs = loadPrefsStore(".state/telegram-prefs.json");
// Persist the poll offset so a restart/redeploy doesn't re-deliver handled updates.
const offsetStore = loadOffsetStore(".state/telegram-offset.json");
const library = loadReferenceLibrary(process.env.REFERENCE_ASSETS_DIR ?? "assets");

const falAdapter: FalLike = {
  subscribe: (endpoint, opts) => fal.subscribe(endpoint, opts) as ReturnType<FalLike["subscribe"]>,
  storage: { upload: (data: Buffer) => fal.storage.upload(new Blob([new Uint8Array(data)])) },
};

const produceImage = async (args: {
  endpoint: string;
  prompt: string;
  inputImages?: Buffer[];
  imageInput?: "image_url" | "image_urls";
}) => {
  const url = await runModel(falAdapter, args);
  const full = await downloadImage(url);
  return toLowRes(full);
};

console.log("Telegram image bot started. Long-polling for updates.");
await runTelegramLoop(
  { telegram, anthropic, produceImage, allowlist: config.allowlist, prefs, library },
  () => false,
  30,
  undefined,
  offsetStore,
);
