import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { fal } from "@fal-ai/client";
import { loadConfig } from "./config.js";
import { Mailbox } from "./mailbox.js";
import { loadProcessedStore } from "./processed.js";
import { loadAttemptStore } from "./attempts.js";
import { runModel, type FalLike } from "./fal-runner.js";
import { downloadImage, toLowRes } from "./image.js";
import { runLoop, type LoopDeps } from "./loop.js";

const config = loadConfig(process.env);

fal.config({ credentials: config.falKey });
const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
const mailbox = new Mailbox(config);
const processed = loadProcessedStore(".processed/uids.json");
const attempts = loadAttemptStore(".processed/attempts.json");

// Adapt the real @fal-ai/client to our FalLike interface. The real
// `fal.storage.upload` expects a Blob, so wrap the Buffer (verified in Task 6).
const falAdapter: FalLike = {
  subscribe: (endpoint, opts) =>
    fal.subscribe(endpoint, opts) as ReturnType<FalLike["subscribe"]>,
  storage: { upload: (data: Buffer) => fal.storage.upload(new Blob([new Uint8Array(data)])) },
};

const produceImage = async (args: { endpoint: string; prompt: string; inputImage?: Buffer }) => {
  const url = await runModel(falAdapter, args);
  const full = await downloadImage(url);
  return toLowRes(full);
};

const deps: LoopDeps = {
  config,
  anthropic,
  produceImage,
  sendReply: (reply) => mailbox.send(reply),
  processed,
  attempts,
  mailbox,
};

console.log(`Email image editor started. Polling every ${config.pollIntervalSeconds}s.`);
runLoop(deps, config.pollIntervalSeconds * 1000, () => false).catch((err) => {
  console.error("Fatal loop error:", err);
  process.exit(1);
});
