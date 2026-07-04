# Email-Driven Image Editor — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A long-running Node/TypeScript service that reads image requests from an email inbox, uses Claude to pick the best Fal.ai model, generates/edits the image, and replies with a low-res result.

**Architecture:** A sequential poll → interpret → generate → reply loop split into focused, independently testable modules (config, catalog, image, interpreter, fal-runner, mailbox, processed-store, orchestrator, loop). Network/side-effecting collaborators (Anthropic, Fal, IMAP/SMTP) are injected as narrow interfaces so the logic is unit-testable with mocks; only the thin connection wrappers and the final wiring are exercised by manual integration.

**Tech Stack:** Node.js 20+, TypeScript, Vitest (tests), zod (validation), `@anthropic-ai/sdk`, `@fal-ai/client`, `imapflow` + `mailparser` (IMAP read), `nodemailer` (SMTP), `sharp` (downscale), `dotenv`, `tsx` (dev run).

## Global Constraints

- Runtime: Node.js 20+ (uses global `fetch`).
- Language: TypeScript, `strict` mode, ESM (`"type": "module"`).
- Tests: Vitest; test files under `test/`, named `*.test.ts`; `npm test` runs `vitest run`.
- Secrets (`ANTHROPIC_API_KEY`, `FAL_KEY`, IMAP/SMTP creds, `ALLOWLIST`) come from env/`.env`; never commit `.env`.
- Claude choices are by **catalog `id`** (stable internal key), never by raw Fal endpoint string.
- **Fal endpoint IDs and the exact `@fal-ai/client` API are verified against fal.ai's live docs during Task 6** — do not trust the placeholders below without checking.
- **Claude model id is `claude-opus-4-8`** (confirmed via the `claude-api` skill; the interpreter uses `client.messages.create` with forced `tool_choice` and no `thinking` param).
- "Low res" = max 1024px long edge, JPEG quality ~80.

---

## File Structure

```
image-editor/
├── package.json, tsconfig.json, vitest.config.ts, .env.example   (Task 1)
├── src/
│   ├── config.ts        # loadConfig(env), isAllowed()           (Task 2)
│   ├── catalog.ts       # model catalog + lookup helpers          (Task 3)
│   ├── image.ts         # toLowRes(), downloadImage()             (Task 4)
│   ├── interpreter.ts   # DecisionSchema, interpret()             (Task 5)
│   ├── fal-runner.ts    # runModel()                              (Task 6)
│   ├── mailbox.ts       # parseIncoming(), buildReply(), Mailbox  (Task 7 + 10)
│   ├── processed.ts     # loadProcessedStore()                    (Task 8)
│   ├── orchestrator.ts  # processEmail()                          (Task 9)
│   ├── loop.ts          # runOnce(), runLoop()                    (Task 10)
│   └── index.ts         # wiring / entrypoint                     (Task 10)
└── test/  *.test.ts
```

---

## Task 1: Project scaffolding & toolchain

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`
- Test: `test/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a working `npm test`, ESM+TS build config that all later tasks rely on.

- [ ] **Step 1: Write the failing smoke test**

`test/smoke.test.ts`:
```ts
import { describe, it, expect } from "vitest";

describe("toolchain", () => {
  it("runs typescript tests", () => {
    const x: number = 1 + 1;
    expect(x).toBe(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL — `npm` errors because there is no `package.json`/vitest yet.

- [ ] **Step 3: Create the project files**

`package.json`:
```json
{
  "name": "email-image-editor",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "dev": "tsx src/index.ts",
    "build": "tsc"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.30.0",
    "@fal-ai/client": "^1.2.0",
    "dotenv": "^16.4.0",
    "imapflow": "^1.0.164",
    "mailparser": "^3.7.0",
    "nodemailer": "^6.9.0",
    "sharp": "^0.33.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/mailparser": "^3.4.4",
    "@types/node": "^20.14.0",
    "@types/nodemailer": "^6.4.15",
    "tsx": "^4.16.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
```

`.env.example`:
```
ANTHROPIC_API_KEY=
FAL_KEY=
IMAP_HOST=imap.gmail.com
IMAP_USER=
IMAP_PASSWORD=
SMTP_HOST=smtp.gmail.com
SMTP_USER=
SMTP_PASSWORD=
ALLOWLIST=teammate1@example.com,teammate2@example.com
POLL_INTERVAL_SECONDS=15
```

- [ ] **Step 4: Install and run the test**

Run: `npm install && npm test`
Expected: PASS — 1 test passes.

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .env.example test/smoke.test.ts package-lock.json
git commit -m "chore: scaffold TypeScript + Vitest toolchain"
```

---

## Task 2: Config loader & allowlist

**Files:**
- Create: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface AppConfig { anthropicApiKey: string; falKey: string; imap: { host: string; user: string; password: string }; smtp: { host: string; user: string; password: string }; allowlist: string[]; pollIntervalSeconds: number }`
  - `loadConfig(env: NodeJS.ProcessEnv): AppConfig`
  - `isAllowed(config: AppConfig, sender: string): boolean`

- [ ] **Step 1: Write the failing test**

`test/config.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { loadConfig, isAllowed } from "../src/config.js";

const base = {
  ANTHROPIC_API_KEY: "a", FAL_KEY: "f",
  IMAP_HOST: "imap", IMAP_USER: "iu", IMAP_PASSWORD: "ip",
  SMTP_HOST: "smtp", SMTP_USER: "su", SMTP_PASSWORD: "sp",
  ALLOWLIST: "Alice@Example.com, bob@example.com",
};

describe("loadConfig", () => {
  it("parses env, allowlist (lowercased), and default poll interval", () => {
    const c = loadConfig(base as NodeJS.ProcessEnv);
    expect(c.anthropicApiKey).toBe("a");
    expect(c.allowlist).toEqual(["alice@example.com", "bob@example.com"]);
    expect(c.pollIntervalSeconds).toBe(15);
  });

  it("throws on a missing required var", () => {
    const { ANTHROPIC_API_KEY, ...rest } = base;
    expect(() => loadConfig(rest as NodeJS.ProcessEnv)).toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe("isAllowed", () => {
  it("matches case-insensitively and rejects others", () => {
    const c = loadConfig(base as NodeJS.ProcessEnv);
    expect(isAllowed(c, "ALICE@example.com")).toBe(true);
    expect(isAllowed(c, "stranger@evil.com")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — cannot find module `../src/config.js`.

- [ ] **Step 3: Write the implementation**

`src/config.ts`:
```ts
export interface AppConfig {
  anthropicApiKey: string;
  falKey: string;
  imap: { host: string; user: string; password: string };
  smtp: { host: string; user: string; password: string };
  allowlist: string[];
  pollIntervalSeconds: number;
}

function req(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  return {
    anthropicApiKey: req(env, "ANTHROPIC_API_KEY"),
    falKey: req(env, "FAL_KEY"),
    imap: { host: req(env, "IMAP_HOST"), user: req(env, "IMAP_USER"), password: req(env, "IMAP_PASSWORD") },
    smtp: { host: req(env, "SMTP_HOST"), user: req(env, "SMTP_USER"), password: req(env, "SMTP_PASSWORD") },
    allowlist: (env.ALLOWLIST ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    pollIntervalSeconds: env.POLL_INTERVAL_SECONDS ? Number(env.POLL_INTERVAL_SECONDS) : 15,
  };
}

export function isAllowed(config: AppConfig, sender: string): boolean {
  return config.allowlist.includes(sender.trim().toLowerCase());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: config loader and allowlist check"
```

---

## Task 3: Model catalog

**Files:**
- Create: `src/catalog.ts`
- Test: `test/catalog.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type TaskType = "generate" | "edit"`
  - `interface CatalogModel { id: string; endpoint: string; label: string; description: string; task: TaskType }`
  - `const CATALOG: CatalogModel[]`
  - `getModel(id: string): CatalogModel | undefined`
  - `modelsForTask(task: TaskType): CatalogModel[]`
  - `isValidChoice(id: string, task: TaskType): boolean`
  - `defaultModelFor(task: TaskType): CatalogModel`

- [ ] **Step 1: Write the failing test**

`test/catalog.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { CATALOG, getModel, modelsForTask, isValidChoice, defaultModelFor } from "../src/catalog.js";

describe("catalog", () => {
  it("has both generate and edit models with unique ids", () => {
    const ids = CATALOG.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(modelsForTask("generate").length).toBeGreaterThan(0);
    expect(modelsForTask("edit").length).toBeGreaterThan(0);
  });

  it("looks up and validates choices by id + task", () => {
    const gen = modelsForTask("generate")[0];
    expect(getModel(gen.id)?.id).toBe(gen.id);
    expect(isValidChoice(gen.id, "generate")).toBe(true);
    expect(isValidChoice(gen.id, "edit")).toBe(false);
    expect(isValidChoice("does-not-exist", "generate")).toBe(false);
  });

  it("provides a default model per task", () => {
    expect(defaultModelFor("generate").task).toBe("generate");
    expect(defaultModelFor("edit").task).toBe("edit");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/catalog.test.ts`
Expected: FAIL — cannot find module `../src/catalog.js`.

- [ ] **Step 3: Write the implementation**

> NOTE: `endpoint` values below are best-effort and MUST be verified against fal.ai's live model pages during Task 6. The `id` values are internal and stable.

`src/catalog.ts`:
```ts
export type TaskType = "generate" | "edit";

export interface CatalogModel {
  id: string;
  endpoint: string;
  label: string;
  description: string;
  task: TaskType;
}

export const CATALOG: CatalogModel[] = [
  // --- generation (text -> image) ---
  { id: "nano-banana-pro", endpoint: "fal-ai/nano-banana-pro", label: "Nano Banana Pro", task: "generate",
    description: "Default quality pick. Complex scenes, best-in-class text and typography rendering." },
  { id: "flux2-pro", endpoint: "fal-ai/flux-2/pro", label: "FLUX.2 [pro]", task: "generate",
    description: "Photorealism and general high-fidelity image generation." },
  { id: "seedream", endpoint: "fal-ai/bytedance/seedream/v4", label: "Seedream V4.5", task: "generate",
    description: "High-aesthetic, stylized and marketing-oriented imagery." },
  { id: "ideogram-v4", endpoint: "fal-ai/ideogram/v4", label: "Ideogram V4", task: "generate",
    description: "Best when the request centers on text, logos, posters, or typography." },
  { id: "recraft-v3", endpoint: "fal-ai/recraft-v3", label: "Recraft V3", task: "generate",
    description: "Design, brand, and vector-style output: icons, precise styles." },
  { id: "flux-schnell", endpoint: "fal-ai/flux/schnell", label: "FLUX schnell", task: "generate",
    description: "Fast and cheap. Use for simple or quick requests where speed and cost win." },
  // --- editing (input image + instruction) ---
  { id: "nano-banana-pro-edit", endpoint: "fal-ai/nano-banana-pro/edit", label: "Nano Banana Pro Edit", task: "edit",
    description: "Default edit pick. Natural-language edits, text edits, strong subject consistency." },
  { id: "flux-kontext-max", endpoint: "fal-ai/flux-pro/kontext/max", label: "FLUX Pro Kontext Max", task: "edit",
    description: "Targeted local edits and whole-scene transforms." },
  { id: "seedream-edit", endpoint: "fal-ai/bytedance/seedream/v4/edit", label: "Seedream Edit", task: "edit",
    description: "Multi-image and style-consistent edits." },
  { id: "qwen-image-edit", endpoint: "fal-ai/qwen-image-edit", label: "Qwen Image Edit", task: "edit",
    description: "Multilingual text-in-image edits." },
];

export function getModel(id: string): CatalogModel | undefined {
  return CATALOG.find((m) => m.id === id);
}

export function modelsForTask(task: TaskType): CatalogModel[] {
  return CATALOG.filter((m) => m.task === task);
}

export function isValidChoice(id: string, task: TaskType): boolean {
  return getModel(id)?.task === task;
}

export function defaultModelFor(task: TaskType): CatalogModel {
  const id = task === "edit" ? "nano-banana-pro-edit" : "nano-banana-pro";
  return getModel(id)!;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/catalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/catalog.ts test/catalog.test.ts
git commit -m "feat: Fal.ai model catalog with lookup helpers"
```

---

## Task 4: Image helpers (downscale + download)

**Files:**
- Create: `src/image.ts`
- Test: `test/image.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `toLowRes(input: Buffer, opts?: { maxEdge?: number; quality?: number }): Promise<Buffer>`
  - `downloadImage(url: string): Promise<Buffer>`

- [ ] **Step 1: Write the failing test**

`test/image.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { toLowRes } from "../src/image.js";

describe("toLowRes", () => {
  it("downscales a large image to <=1024px long edge and encodes JPEG", async () => {
    const big = await sharp({
      create: { width: 2000, height: 1500, channels: 3, background: { r: 10, g: 120, b: 200 } },
    }).png().toBuffer();

    const out = await toLowRes(big);
    const meta = await sharp(out).metadata();

    expect(meta.format).toBe("jpeg");
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1024);
  });

  it("does not enlarge a small image", async () => {
    const small = await sharp({
      create: { width: 300, height: 300, channels: 3, background: { r: 0, g: 0, b: 0 } },
    }).png().toBuffer();

    const out = await toLowRes(small);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(300);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/image.test.ts`
Expected: FAIL — cannot find module `../src/image.js`.

- [ ] **Step 3: Write the implementation**

`src/image.ts`:
```ts
import sharp from "sharp";

export async function toLowRes(
  input: Buffer,
  opts: { maxEdge?: number; quality?: number } = {},
): Promise<Buffer> {
  const maxEdge = opts.maxEdge ?? 1024;
  const quality = opts.quality ?? 80;
  return sharp(input)
    .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality })
    .toBuffer();
}

export async function downloadImage(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image download failed: ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/image.test.ts`
Expected: PASS. (`downloadImage` is a thin `fetch` wrapper exercised by the manual integration test in Task 10.)

- [ ] **Step 5: Commit**

```bash
git add src/image.ts test/image.test.ts
git commit -m "feat: low-res downscale and image download helpers"
```

---

## Task 5: Interpreter (Claude → structured decision)

**Files:**
- Create: `src/interpreter.ts`
- Test: `test/interpreter.test.ts`

> The `claude-api` skill has been consulted: use model id `claude-opus-4-8` (the skill's default — do not downgrade for cost without the user asking) with standard Messages tool-use (`client.messages.create` + forced `tool_choice`). Do not pass a `thinking` param — omitting it runs Opus 4.8 without thinking, which is right for this fast structured routing call.

**Interfaces:**
- Consumes: `CATALOG`, `isValidChoice`, `defaultModelFor` from `src/catalog.js`.
- Produces:
  - `type Decision =` a discriminated union on `task`:
    - `{ task: "clarify"; message: string }`
    - `{ task: "generate"; modelId: string; prompt: string; aspectRatio?: string }`
    - `{ task: "edit"; modelId: string; prompt: string; aspectRatio?: string }`
  - `interface AnthropicLike { messages: { create(args: any): Promise<{ content: Array<{ type: string; name?: string; input?: unknown }> }> } }`
  - `interpret(client: AnthropicLike, input: { text: string; hasImage: boolean }): Promise<Decision>`

- [ ] **Step 1: Write the failing test**

`test/interpreter.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { interpret, type AnthropicLike } from "../src/interpreter.js";
import { defaultModelFor } from "../src/catalog.js";

function fakeClient(toolInput: unknown): AnthropicLike {
  return {
    messages: {
      async create() {
        return { content: [{ type: "tool_use", name: "decide", input: toolInput }] };
      },
    },
  };
}

describe("interpret", () => {
  it("returns a validated generate decision", async () => {
    const client = fakeClient({ task: "generate", modelId: "flux-schnell", prompt: "a red bike" });
    const d = await interpret(client, { text: "make a red bike", hasImage: false });
    expect(d).toEqual({ task: "generate", modelId: "flux-schnell", prompt: "a red bike" });
  });

  it("falls back to the default model when Claude picks an invalid id", async () => {
    const client = fakeClient({ task: "edit", modelId: "not-a-real-model", prompt: "remove the sign" });
    const d = await interpret(client, { text: "remove the sign", hasImage: true });
    expect(d.task).toBe("edit");
    if (d.task !== "clarify") expect(d.modelId).toBe(defaultModelFor("edit").id);
  });

  it("passes through a clarify decision", async () => {
    const client = fakeClient({ task: "clarify", message: "What should I create?" });
    const d = await interpret(client, { text: "hi", hasImage: false });
    expect(d).toEqual({ task: "clarify", message: "What should I create?" });
  });

  it("throws when the model returns no tool_use block", async () => {
    const client: AnthropicLike = { messages: { async create() { return { content: [{ type: "text" }] }; } } };
    await expect(interpret(client, { text: "x", hasImage: false })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/interpreter.test.ts`
Expected: FAIL — cannot find module `../src/interpreter.js`.

- [ ] **Step 3: Write the implementation**

`src/interpreter.ts`:
```ts
import { z } from "zod";
import { CATALOG, isValidChoice, defaultModelFor, type TaskType } from "./catalog.js";

export const DecisionSchema = z.discriminatedUnion("task", [
  z.object({ task: z.literal("clarify"), message: z.string().min(1) }),
  z.object({ task: z.literal("generate"), modelId: z.string(), prompt: z.string().min(1), aspectRatio: z.string().optional() }),
  z.object({ task: z.literal("edit"), modelId: z.string(), prompt: z.string().min(1), aspectRatio: z.string().optional() }),
]);

export type Decision = z.infer<typeof DecisionSchema>;

export interface AnthropicLike {
  messages: {
    create(args: any): Promise<{ content: Array<{ type: string; name?: string; input?: unknown }> }>;
  };
}

const DECIDE_TOOL = {
  name: "decide",
  description: "Decide how to handle the image request.",
  input_schema: {
    type: "object",
    properties: {
      task: { type: "string", enum: ["generate", "edit", "clarify"] },
      modelId: { type: "string", description: "Catalog id of the chosen model (omit for clarify)." },
      prompt: { type: "string", description: "The refined prompt for the model (omit for clarify)." },
      aspectRatio: { type: "string", description: "Optional, e.g. '1:1', '16:9'." },
      message: { type: "string", description: "For clarify only: what to ask the sender." },
    },
    required: ["task"],
  },
} as const;

function systemPrompt(): string {
  const lines = CATALOG.map((m) => `- ${m.id} (${m.task}): ${m.description}`).join("\n");
  return [
    "You route image-creation and image-editing requests sent by email.",
    "Decide whether the request is a text-to-image generation, an edit of an attached image, or too unclear to act on.",
    "Pick the single best model from this catalog by its id, and write a clean, specific prompt for that model.",
    "If an image is attached, prefer an 'edit' model; if none is attached, you cannot edit, so use 'generate' or 'clarify'.",
    "If the request is empty or too vague to act on, use task 'clarify' and ask a short question.",
    "",
    "Catalog:",
    lines,
  ].join("\n");
}

export async function interpret(
  client: AnthropicLike,
  input: { text: string; hasImage: boolean },
): Promise<Decision> {
  const res = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 1024,
    system: systemPrompt(),
    tools: [DECIDE_TOOL],
    tool_choice: { type: "tool", name: "decide" },
    messages: [
      {
        role: "user",
        content: `Image attached: ${input.hasImage ? "yes" : "no"}\n\nRequest:\n${input.text || "(empty)"}`,
      },
    ],
  });

  const block = res.content.find((b) => b.type === "tool_use" && b.name === "decide");
  if (!block) throw new Error("Interpreter: model returned no tool_use decision");

  const decision = DecisionSchema.parse(block.input);

  if (decision.task !== "clarify" && !isValidChoice(decision.modelId, decision.task as TaskType)) {
    decision.modelId = defaultModelFor(decision.task as TaskType).id;
  }
  return decision;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/interpreter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/interpreter.ts test/interpreter.test.ts
git commit -m "feat: Claude interpreter returning validated routing decision"
```

---

## Task 6: Fal runner

**Files:**
- Create: `src/fal-runner.ts`
- Test: `test/fal-runner.test.ts`

> Before writing this task, open the fal.ai model pages to confirm (a) each catalog `endpoint` string, (b) the `@fal-ai/client` `subscribe`/`storage.upload` API, and (c) the result field holding the image URL (assumed `data.images[0].url`). Fix `src/catalog.ts` endpoints if any differ.

**Interfaces:**
- Consumes: nothing from earlier tasks (operates on a resolved `endpoint`).
- Produces:
  - `interface FalLike { subscribe(endpoint: string, opts: { input: Record<string, unknown> }): Promise<{ data: { images?: Array<{ url: string }> } }>; storage: { upload(data: Buffer): Promise<string> } }`
  - `interface RunArgs { endpoint: string; prompt: string; inputImage?: Buffer }`
  - `runModel(fal: FalLike, args: RunArgs): Promise<string>` — returns the result image URL.

- [ ] **Step 1: Write the failing test**

`test/fal-runner.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { runModel, type FalLike } from "../src/fal-runner.js";

describe("runModel", () => {
  it("generates without uploading when there is no input image", async () => {
    const subscribe = vi.fn().mockResolvedValue({ data: { images: [{ url: "https://x/out.png" }] } });
    const upload = vi.fn();
    const fal: FalLike = { subscribe, storage: { upload } };

    const url = await runModel(fal, { endpoint: "fal-ai/flux/schnell", prompt: "a cat" });

    expect(url).toBe("https://x/out.png");
    expect(upload).not.toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalledWith("fal-ai/flux/schnell", { input: { prompt: "a cat" } });
  });

  it("uploads the input image and passes image_url for edits", async () => {
    const subscribe = vi.fn().mockResolvedValue({ data: { images: [{ url: "https://x/edited.png" }] } });
    const upload = vi.fn().mockResolvedValue("https://x/input.png");
    const fal: FalLike = { subscribe, storage: { upload } };

    const url = await runModel(fal, {
      endpoint: "fal-ai/nano-banana-pro/edit", prompt: "make it night", inputImage: Buffer.from("img"),
    });

    expect(upload).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledWith("fal-ai/nano-banana-pro/edit", {
      input: { prompt: "make it night", image_url: "https://x/input.png" },
    });
    expect(url).toBe("https://x/edited.png");
  });

  it("throws when the result has no image", async () => {
    const fal: FalLike = { subscribe: vi.fn().mockResolvedValue({ data: {} }), storage: { upload: vi.fn() } };
    await expect(runModel(fal, { endpoint: "e", prompt: "p" })).rejects.toThrow(/no image/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/fal-runner.test.ts`
Expected: FAIL — cannot find module `../src/fal-runner.js`.

- [ ] **Step 3: Write the implementation**

`src/fal-runner.ts`:
```ts
export interface FalLike {
  subscribe(
    endpoint: string,
    opts: { input: Record<string, unknown> },
  ): Promise<{ data: { images?: Array<{ url: string }> } }>;
  storage: { upload(data: Buffer): Promise<string> };
}

export interface RunArgs {
  endpoint: string;
  prompt: string;
  inputImage?: Buffer;
}

export async function runModel(fal: FalLike, args: RunArgs): Promise<string> {
  const input: Record<string, unknown> = { prompt: args.prompt };
  if (args.inputImage) {
    input.image_url = await fal.storage.upload(args.inputImage);
  }
  const res = await fal.subscribe(args.endpoint, { input });
  const url = res.data.images?.[0]?.url;
  if (!url) throw new Error("Fal returned no image in result");
  return url;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/fal-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fal-runner.ts test/fal-runner.test.ts
git commit -m "feat: fal-runner to call chosen model and return image URL"
```

---

## Task 7: Email parse & reply builders

**Files:**
- Create: `src/mailbox.ts` (pure helpers only in this task; connection wrapper added in Task 10)
- Test: `test/mailbox.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface IncomingEmail { uid: number; from: string; subject: string; text: string; imageAttachment?: Buffer; messageId: string; references: string }`
  - `interface OutgoingReply { to: string; subject: string; text: string; image?: Buffer; filename: string; inReplyTo: string; references: string }`
  - `parseIncoming(raw: Buffer, uid: number): Promise<IncomingEmail>`
  - `buildReply(incoming: IncomingEmail, opts: { text: string; image?: Buffer; filename?: string }): OutgoingReply`

- [ ] **Step 1: Write the failing test**

`test/mailbox.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseIncoming, buildReply } from "../src/mailbox.js";

const rawEmail = Buffer.from(
  [
    "From: Alice <Alice@Example.com>",
    "To: bot@example.com",
    "Subject: make a logo",
    "Message-ID: <abc@mail>",
    "Content-Type: text/plain",
    "",
    "A minimalist fox logo, orange.",
    "",
  ].join("\r\n"),
);

describe("parseIncoming", () => {
  it("extracts sender (lowercased), subject, text, and message id", async () => {
    const e = await parseIncoming(rawEmail, 42);
    expect(e.uid).toBe(42);
    expect(e.from).toBe("alice@example.com");
    expect(e.subject).toBe("make a logo");
    expect(e.text).toBe("A minimalist fox logo, orange.");
    expect(e.messageId).toBe("<abc@mail>");
    expect(e.imageAttachment).toBeUndefined();
  });
});

describe("buildReply", () => {
  const incoming = {
    uid: 1, from: "alice@example.com", subject: "make a logo",
    text: "", messageId: "<abc@mail>", references: "",
  };

  it("builds an in-thread reply with an image attachment", () => {
    const r = buildReply(incoming, { text: "done", image: Buffer.from("x"), filename: "result.jpg" });
    expect(r.to).toBe("alice@example.com");
    expect(r.subject).toBe("Re: make a logo");
    expect(r.inReplyTo).toBe("<abc@mail>");
    expect(r.references).toContain("<abc@mail>");
    expect(r.image).toBeInstanceOf(Buffer);
  });

  it("builds a text-only reply and does not double-prefix Re:", () => {
    const r = buildReply({ ...incoming, subject: "Re: make a logo" }, { text: "what next?" });
    expect(r.subject).toBe("Re: make a logo");
    expect(r.image).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/mailbox.test.ts`
Expected: FAIL — cannot find module `../src/mailbox.js`.

- [ ] **Step 3: Write the implementation**

`src/mailbox.ts`:
```ts
import { simpleParser } from "mailparser";

export interface IncomingEmail {
  uid: number;
  from: string;
  subject: string;
  text: string;
  imageAttachment?: Buffer;
  messageId: string;
  references: string;
}

export interface OutgoingReply {
  to: string;
  subject: string;
  text: string;
  image?: Buffer;
  filename: string;
  inReplyTo: string;
  references: string;
}

export async function parseIncoming(raw: Buffer, uid: number): Promise<IncomingEmail> {
  const p = await simpleParser(raw);
  const from = (p.from?.value?.[0]?.address ?? "").toLowerCase();
  const image = p.attachments.find((a) => (a.contentType ?? "").startsWith("image/"));
  const references = Array.isArray(p.references) ? p.references.join(" ") : (p.references ?? "");
  return {
    uid,
    from,
    subject: p.subject ?? "",
    text: (p.text ?? "").trim(),
    imageAttachment: image?.content,
    messageId: p.messageId ?? "",
    references,
  };
}

export function buildReply(
  incoming: IncomingEmail,
  opts: { text: string; image?: Buffer; filename?: string },
): OutgoingReply {
  const subject = incoming.subject.startsWith("Re:") ? incoming.subject : `Re: ${incoming.subject}`;
  const references = [incoming.references, incoming.messageId].filter(Boolean).join(" ");
  return {
    to: incoming.from,
    subject,
    text: opts.text,
    image: opts.image,
    filename: opts.filename ?? "result.jpg",
    inReplyTo: incoming.messageId,
    references,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/mailbox.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mailbox.ts test/mailbox.test.ts
git commit -m "feat: email parsing and in-thread reply builder"
```

---

## Task 8: Processed store (dedup)

**Files:**
- Create: `src/processed.ts`
- Test: `test/processed.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface ProcessedStore { has(uid: number): boolean; add(uid: number): void }`
  - `loadProcessedStore(filePath: string): ProcessedStore` — file-backed, persists on `add`.

- [ ] **Step 1: Write the failing test**

`test/processed.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { loadProcessedStore } from "../src/processed.js";

describe("processed store", () => {
  it("records ids and persists them across reloads", () => {
    const path = join(tmpdir(), `proc-${process.pid}.json`);
    rmSync(path, { force: true });

    const store = loadProcessedStore(path);
    expect(store.has(7)).toBe(false);
    store.add(7);
    expect(store.has(7)).toBe(true);

    const reloaded = loadProcessedStore(path);
    expect(reloaded.has(7)).toBe(true);

    rmSync(path, { force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/processed.test.ts`
Expected: FAIL — cannot find module `../src/processed.js`.

- [ ] **Step 3: Write the implementation**

`src/processed.ts`:
```ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface ProcessedStore {
  has(uid: number): boolean;
  add(uid: number): void;
}

export function loadProcessedStore(filePath: string): ProcessedStore {
  const set = new Set<number>();
  if (existsSync(filePath)) {
    try {
      const arr = JSON.parse(readFileSync(filePath, "utf8")) as number[];
      for (const n of arr) set.add(n);
    } catch {
      // corrupt or empty file: start fresh
    }
  }
  const persist = () => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify([...set]));
  };
  return {
    has: (uid) => set.has(uid),
    add: (uid) => {
      set.add(uid);
      persist();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/processed.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/processed.ts test/processed.test.ts
git commit -m "feat: file-backed processed-uid store for dedup"
```

---

## Task 9: Orchestrator (processEmail)

**Files:**
- Create: `src/orchestrator.ts`
- Test: `test/orchestrator.test.ts`

**Interfaces:**
- Consumes: `AppConfig`, `isAllowed` (config); `AnthropicLike`, `interpret` (interpreter); `getModel` (catalog); `IncomingEmail`, `OutgoingReply`, `buildReply` (mailbox); `ProcessedStore` (processed).
- Produces:
  - `type ProcessResult = "skipped-duplicate" | "skipped-not-allowed" | "clarified" | "generated" | "error"`
  - `interface OrchestratorDeps { config: AppConfig; anthropic: AnthropicLike; produceImage: (args: { endpoint: string; prompt: string; inputImage?: Buffer }) => Promise<Buffer>; sendReply: (reply: OutgoingReply) => Promise<void>; processed: ProcessedStore }`
  - `processEmail(email: IncomingEmail, deps: OrchestratorDeps): Promise<ProcessResult>`

- [ ] **Step 1: Write the failing test**

`test/orchestrator.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { processEmail, type OrchestratorDeps } from "../src/orchestrator.js";
import type { AnthropicLike } from "../src/interpreter.js";
import type { IncomingEmail } from "../src/mailbox.js";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = {
  anthropicApiKey: "a", falKey: "f",
  imap: { host: "", user: "", password: "" },
  smtp: { host: "", user: "", password: "" },
  allowlist: ["alice@example.com"], pollIntervalSeconds: 15,
};

function anthropicReturning(input: unknown): AnthropicLike {
  return { messages: { async create() { return { content: [{ type: "tool_use", name: "decide", input }] }; } } };
}

function baseEmail(over: Partial<IncomingEmail> = {}): IncomingEmail {
  return { uid: 1, from: "alice@example.com", subject: "make a bike", text: "", messageId: "<m>", references: "", ...over };
}

function deps(over: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    config,
    anthropic: anthropicReturning({ task: "generate", modelId: "flux-schnell", prompt: "a bike" }),
    produceImage: vi.fn().mockResolvedValue(Buffer.from("img")),
    sendReply: vi.fn().mockResolvedValue(undefined),
    processed: { has: () => false, add: vi.fn() },
    ...over,
  };
}

describe("processEmail", () => {
  it("skips senders not on the allowlist without replying", async () => {
    const d = deps();
    const r = await processEmail(baseEmail({ from: "stranger@evil.com" }), d);
    expect(r).toBe("skipped-not-allowed");
    expect(d.sendReply).not.toHaveBeenCalled();
    expect(d.processed.add).toHaveBeenCalledWith(1);
  });

  it("skips already-processed emails", async () => {
    const d = deps({ processed: { has: () => true, add: vi.fn() } });
    const r = await processEmail(baseEmail(), d);
    expect(r).toBe("skipped-duplicate");
  });

  it("generates and replies with an image on a valid request", async () => {
    const d = deps();
    const r = await processEmail(baseEmail(), d);
    expect(r).toBe("generated");
    expect(d.produceImage).toHaveBeenCalledWith({ endpoint: "fal-ai/flux/schnell", prompt: "a bike", inputImage: undefined });
    const reply = (d.sendReply as any).mock.calls[0][0];
    expect(reply.image).toBeInstanceOf(Buffer);
  });

  it("asks for clarification when an edit is requested with no attached image", async () => {
    const d = deps({ anthropic: anthropicReturning({ task: "edit", modelId: "nano-banana-pro-edit", prompt: "night" }) });
    const r = await processEmail(baseEmail(), d); // no imageAttachment
    expect(r).toBe("clarified");
    const reply = (d.sendReply as any).mock.calls[0][0];
    expect(reply.image).toBeUndefined();
    expect(d.produceImage).not.toHaveBeenCalled();
  });

  it("replies with an error message when generation throws", async () => {
    const d = deps({ produceImage: vi.fn().mockRejectedValue(new Error("boom")) });
    const r = await processEmail(baseEmail(), d);
    expect(r).toBe("error");
    const reply = (d.sendReply as any).mock.calls[0][0];
    expect(reply.text).toMatch(/failed/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/orchestrator.test.ts`
Expected: FAIL — cannot find module `../src/orchestrator.js`.

- [ ] **Step 3: Write the implementation**

`src/orchestrator.ts`:
```ts
import { type AppConfig, isAllowed } from "./config.js";
import { type AnthropicLike, interpret } from "./interpreter.js";
import { getModel } from "./catalog.js";
import { type IncomingEmail, type OutgoingReply, buildReply } from "./mailbox.js";
import { type ProcessedStore } from "./processed.js";

export type ProcessResult =
  | "skipped-duplicate"
  | "skipped-not-allowed"
  | "clarified"
  | "generated"
  | "error";

export interface OrchestratorDeps {
  config: AppConfig;
  anthropic: AnthropicLike;
  produceImage: (args: { endpoint: string; prompt: string; inputImage?: Buffer }) => Promise<Buffer>;
  sendReply: (reply: OutgoingReply) => Promise<void>;
  processed: ProcessedStore;
}

export async function processEmail(email: IncomingEmail, deps: OrchestratorDeps): Promise<ProcessResult> {
  if (deps.processed.has(email.uid)) return "skipped-duplicate";

  if (!isAllowed(deps.config, email.from)) {
    deps.processed.add(email.uid);
    return "skipped-not-allowed";
  }

  const instruction = [email.subject, email.text].filter(Boolean).join("\n");
  const decision = await interpret(deps.anthropic, {
    text: instruction,
    hasImage: !!email.imageAttachment,
  });

  const needsClarify =
    decision.task === "clarify" || (decision.task === "edit" && !email.imageAttachment);

  if (needsClarify) {
    const message =
      decision.task === "clarify"
        ? decision.message
        : "It looks like you want to edit an image, but none was attached. Please reply with the image attached and describe the change.";
    await deps.sendReply(buildReply(email, { text: message }));
    deps.processed.add(email.uid);
    return "clarified";
  }

  try {
    const model = getModel(decision.modelId)!; // validated in interpret()
    const image = await deps.produceImage({
      endpoint: model.endpoint,
      prompt: decision.prompt,
      inputImage: decision.task === "edit" ? email.imageAttachment : undefined,
    });
    await deps.sendReply(
      buildReply(email, {
        text: `Done — created with ${model.label}.\nPrompt: ${decision.prompt}`,
        image,
        filename: "result.jpg",
      }),
    );
    deps.processed.add(email.uid);
    return "generated";
  } catch (err) {
    console.error(`Generation failed for uid ${email.uid}:`, err);
    await deps.sendReply(
      buildReply(email, {
        text: "Sorry — that request failed to generate. Try rephrasing it and send again.",
      }),
    );
    deps.processed.add(email.uid);
    return "error";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/orchestrator.test.ts`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator.ts test/orchestrator.test.ts
git commit -m "feat: orchestrator handling allowlist, clarify, generate, error paths"
```

---

## Task 10: Mailbox connection, loop & entrypoint (integration wiring)

**Files:**
- Modify: `src/mailbox.ts` (add the `Mailbox` connection class)
- Create: `src/loop.ts`, `src/index.ts`
- Test: `test/loop.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–9, plus `imapflow`, `nodemailer`, `@fal-ai/client`, `@anthropic-ai/sdk`, `runModel` (fal-runner), `toLowRes`/`downloadImage` (image).
- Produces:
  - `class Mailbox { constructor(config: AppConfig); fetchUnread(): Promise<IncomingEmail[]>; markSeen(uid: number): Promise<void>; send(reply: OutgoingReply): Promise<void> }`
  - `interface LoopDeps extends OrchestratorDeps { mailbox: { fetchUnread(): Promise<IncomingEmail[]>; markSeen(uid: number): Promise<void> } }`
  - `runOnce(deps: LoopDeps, process?: typeof processEmail): Promise<void>`
  - `runLoop(deps: LoopDeps, intervalMs: number, shouldStop: () => boolean): Promise<void>`

- [ ] **Step 1: Write the failing test for the loop logic**

`test/loop.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { runOnce, type LoopDeps } from "../src/loop.js";
import type { IncomingEmail } from "../src/mailbox.js";

function email(uid: number): IncomingEmail {
  return { uid, from: "a@b.com", subject: "s", text: "", messageId: "<m>", references: "" };
}

describe("runOnce", () => {
  it("processes each unread email and marks it seen", async () => {
    const markSeen = vi.fn().mockResolvedValue(undefined);
    const deps = {
      mailbox: { fetchUnread: vi.fn().mockResolvedValue([email(1), email(2)]), markSeen },
    } as unknown as LoopDeps;

    const fakeProcess = vi.fn().mockResolvedValue("generated");
    await runOnce(deps, fakeProcess as any);

    expect(fakeProcess).toHaveBeenCalledTimes(2);
    expect(markSeen).toHaveBeenCalledWith(1);
    expect(markSeen).toHaveBeenCalledWith(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/loop.test.ts`
Expected: FAIL — cannot find module `../src/loop.js`.

- [ ] **Step 3a: Add the Mailbox connection class to `src/mailbox.ts`**

Append to `src/mailbox.ts`:
```ts
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type { AppConfig } from "./config.js";

export class Mailbox {
  constructor(private config: AppConfig) {}

  async fetchUnread(): Promise<IncomingEmail[]> {
    const client = new ImapFlow({
      host: this.config.imap.host,
      port: 993,
      secure: true,
      auth: { user: this.config.imap.user, pass: this.config.imap.password },
      logger: false,
    });
    const out: IncomingEmail[] = [];
    await client.connect();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        for await (const msg of client.fetch({ seen: false }, { uid: true, source: true })) {
          if (!msg.source) continue;
          out.push(await parseIncoming(msg.source as Buffer, msg.uid));
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
    return out;
  }

  async markSeen(uid: number): Promise<void> {
    const client = new ImapFlow({
      host: this.config.imap.host,
      port: 993,
      secure: true,
      auth: { user: this.config.imap.user, pass: this.config.imap.password },
      logger: false,
    });
    await client.connect();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        await client.messageFlagsAdd({ uid: String(uid) }, ["\\Seen"], { uid: true });
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  async send(reply: OutgoingReply): Promise<void> {
    const transport = nodemailer.createTransport({
      host: this.config.smtp.host,
      port: 465,
      secure: true,
      auth: { user: this.config.smtp.user, pass: this.config.smtp.password },
    });
    await transport.sendMail({
      from: this.config.smtp.user,
      to: reply.to,
      subject: reply.subject,
      text: reply.text,
      inReplyTo: reply.inReplyTo || undefined,
      references: reply.references || undefined,
      attachments: reply.image ? [{ filename: reply.filename, content: reply.image }] : [],
    });
  }
}
```

- [ ] **Step 3b: Create `src/loop.ts`**

`src/loop.ts`:
```ts
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
```

- [ ] **Step 4: Run the loop test to verify it passes**

Run: `npx vitest run test/loop.test.ts`
Expected: PASS.

- [ ] **Step 5: Create the entrypoint `src/index.ts`**

`src/index.ts`:
```ts
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { fal } from "@fal-ai/client";
import { loadConfig } from "./config.js";
import { Mailbox } from "./mailbox.js";
import { loadProcessedStore } from "./processed.js";
import { runModel, type FalLike } from "./fal-runner.js";
import { downloadImage, toLowRes } from "./image.js";
import { runLoop, type LoopDeps } from "./loop.js";

const config = loadConfig(process.env);

fal.config({ credentials: config.falKey });
const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
const mailbox = new Mailbox(config);
const processed = loadProcessedStore(".processed/uids.json");

// Adapt the real @fal-ai/client to our FalLike interface. The real
// `fal.storage.upload` expects a Blob, so wrap the Buffer (verified in Task 6).
const falAdapter: FalLike = {
  subscribe: (endpoint, opts) =>
    fal.subscribe(endpoint, opts) as ReturnType<FalLike["subscribe"]>,
  // Wrap Buffer in a Uint8Array so it satisfies BlobPart under strict lib types.
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
  mailbox,
};

console.log(`Email image editor started. Polling every ${config.pollIntervalSeconds}s.`);
runLoop(deps, config.pollIntervalSeconds * 1000, () => false).catch((err) => {
  console.error("Fatal loop error:", err);
  process.exit(1);
});
```

- [ ] **Step 6: Verify the full unit suite passes**

Run: `npm test`
Expected: PASS — every task's tests are green.

- [ ] **Step 7: Manual integration test (real services)**

This exercises the paths that cannot be unit-tested (real IMAP/SMTP, Fal, Claude, `downloadImage`, `produceImage` wiring, and the verified Fal endpoints/`@fal-ai/client` API from Task 6).

1. Copy `.env.example` to `.env` and fill in real values (Gmail app password, `FAL_KEY`, `ANTHROPIC_API_KEY`, your own address in `ALLOWLIST`).
2. Run `npm run dev`.
3. From an allowlisted address, email the inbox: subject "a watercolor fox", no attachment. Confirm you receive an in-thread reply with a low-res JPEG.
4. Reply with an image attached and "make the background night". Confirm you receive an edited low-res image.
5. Send from a non-allowlisted address. Confirm no reply and a `skipped-not-allowed` log line.
6. Send an empty/vague email from an allowlisted address. Confirm a clarification reply.

- [ ] **Step 8: Commit**

```bash
git add src/mailbox.ts src/loop.ts src/index.ts test/loop.test.ts
git commit -m "feat: IMAP/SMTP mailbox, poll loop, and entrypoint wiring"
```

---

## Self-Review Notes (author check against the spec)

- **Spec coverage:** poll inbox (Task 10); allowlist (Tasks 2, 9); Claude interpret + model choice (Tasks 3, 5); generate/edit via Fal (Task 6); low-res in-thread reply (Tasks 4, 7, 9); error/clarify/dedup handling (Tasks 8, 9); secrets via `.env` (Tasks 1, 2, 10). All spec sections map to a task.
- **Deferred verifications (explicit, not placeholders):** Fal endpoint strings + `@fal-ai/client` API shape (Task 6); exact Claude model id + tool-use params via `claude-api` skill (Task 5).
- **Type consistency:** `Decision`, `IncomingEmail`, `OutgoingReply`, `OrchestratorDeps`, `LoopDeps`, `FalLike`, `AnthropicLike`, `ProcessedStore` names/signatures are used identically across Tasks 5–10.
