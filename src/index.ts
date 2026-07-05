import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { fal } from "@fal-ai/client";
import { google } from "googleapis";
import { loadConfig } from "./config.js";
import { GmailMailbox, type GmailApi } from "./mailbox.js";
import { loadProcessedStore } from "./processed.js";
import { loadAttemptStore } from "./attempts.js";
import { runModel, type FalLike } from "./fal-runner.js";
import { downloadImage, toLowRes } from "./image.js";
import { runLoop, type LoopDeps } from "./loop.js";

const config = loadConfig(process.env);

fal.config({ credentials: config.falKey });
const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

const auth = new google.auth.JWT({
  keyFile: config.gmail.serviceAccountKeyFile,
  scopes: [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
  ],
  subject: config.gmail.impersonatedUser,
});
const gmail = google.gmail({ version: "v1", auth });
const mailbox = new GmailMailbox(gmail as unknown as GmailApi, config.gmail.impersonatedUser);

const processed = loadProcessedStore(".processed/ids.json");
const attempts = loadAttemptStore(".processed/attempts.json");

// Adapt the real @fal-ai/client to our FalLike interface. The real
// `fal.storage.upload` expects a Blob, so wrap the Buffer in a Uint8Array.
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

console.log(`Email image editor started as ${config.gmail.impersonatedUser}. Polling every ${config.pollIntervalSeconds}s.`);
runLoop(deps, config.pollIntervalSeconds * 1000, () => false).catch((err) => {
  console.error("Fatal loop error:", err);
  process.exit(1);
});
