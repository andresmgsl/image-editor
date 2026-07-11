# Telegram Bot Front-End Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Telegram bot front-end that reuses the existing interpret→fal→downscale core, with per-user model pinning and model+prompt shown on every reply.

**Architecture:** Telegram becomes the active transport; email code stays dormant. New modules mirror the email side's dependency-injection style: a narrow `TelegramApi` interface (raw-`fetch` implementation) so the orchestration (`telegram-handler.ts`) is unit-testable with fakes. Long polling — no inbound ports.

**Tech Stack:** Node 20 (ESM, NodeNext), TypeScript strict, Vitest, `@anthropic-ai/sdk`, `@fal-ai/client`, `sharp`. Telegram via the raw Bot API using global `fetch`/`FormData`/`Blob` — no new dependency.

## Global Constraints

- ESM with NodeNext: all relative imports end in `.js` (even though sources are `.ts`).
- TDD: write the failing test, watch it fail, minimal code, watch it pass, commit.
- Reuse the existing core unchanged: `interpret()`, `runModel()`, `catalog.ts`, `image.ts`.
- Model routing stays automatic; a pinned model applies only when `isValidChoice(pinned, task)`.
- Single image per edit in v1 (`inputImages` is a one-element array).
- Access control: numeric Telegram user-id allowlist; unknown senders get their id echoed.
- Every generation/edit prints one console line: `user=<id> task=<t> model=<id> pinned=<auto|id> prompt="..." <ok|err> <s>s`.
- New env vars: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWLIST` (comma-separated numeric ids).
- Do NOT modify the existing `loadConfig`/email config path.

---

### Task 1: Telegram config loader

**Files:**
- Modify: `src/config.ts` (add, do not touch `loadConfig`/`loadGmailConfig`/`isAllowed`)
- Test: `test/config.test.ts` (append a `describe("loadTelegramConfig")`)

**Interfaces:**
- Consumes: existing `req(env, key)` helper in `config.ts`.
- Produces:
  - `interface TelegramConfig { anthropicApiKey: string; falKey: string; botToken: string; allowlist: number[] }`
  - `loadTelegramConfig(env: NodeJS.ProcessEnv): TelegramConfig`
  - `isUserAllowed(config: { allowlist: number[] }, userId: number): boolean`

- [ ] **Step 1: Write the failing tests**

Append to `test/config.test.ts`:

```ts
import { loadTelegramConfig, isUserAllowed } from "../src/config.js";

const tgBase = { ANTHROPIC_API_KEY: "a", FAL_KEY: "f", TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_ALLOWLIST: "111, 222" };

describe("loadTelegramConfig", () => {
  it("parses token, keys, and numeric allowlist", () => {
    const c = loadTelegramConfig(tgBase as unknown as NodeJS.ProcessEnv);
    expect(c.anthropicApiKey).toBe("a");
    expect(c.falKey).toBe("f");
    expect(c.botToken).toBe("123:abc");
    expect(c.allowlist).toEqual([111, 222]);
  });

  it("throws on a missing TELEGRAM_BOT_TOKEN", () => {
    const { TELEGRAM_BOT_TOKEN, ...rest } = tgBase;
    expect(() => loadTelegramConfig(rest as unknown as NodeJS.ProcessEnv)).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it("throws when the allowlist is empty", () => {
    expect(() => loadTelegramConfig({ ...tgBase, TELEGRAM_ALLOWLIST: "" } as unknown as NodeJS.ProcessEnv)).toThrow(/TELEGRAM_ALLOWLIST/);
  });

  it("throws on a non-numeric allowlist id", () => {
    expect(() => loadTelegramConfig({ ...tgBase, TELEGRAM_ALLOWLIST: "111, bob" } as unknown as NodeJS.ProcessEnv)).toThrow(/bob/);
  });
});

describe("isUserAllowed", () => {
  it("accepts listed ids and rejects others", () => {
    const c = loadTelegramConfig(tgBase as unknown as NodeJS.ProcessEnv);
    expect(isUserAllowed(c, 111)).toBe(true);
    expect(isUserAllowed(c, 999)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — `loadTelegramConfig is not a function` / import error.

- [ ] **Step 3: Write minimal implementation**

Append to `src/config.ts`:

```ts
export interface TelegramConfig {
  anthropicApiKey: string;
  falKey: string;
  botToken: string;
  allowlist: number[];
}

function parseUserIds(raw: string | undefined): number[] {
  const ids = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const n = Number(s);
      if (!Number.isInteger(n)) throw new Error(`Invalid TELEGRAM_ALLOWLIST id: ${s}`);
      return n;
    });
  if (ids.length === 0) throw new Error("TELEGRAM_ALLOWLIST must list at least one numeric user id");
  return ids;
}

export function loadTelegramConfig(env: NodeJS.ProcessEnv): TelegramConfig {
  return {
    anthropicApiKey: req(env, "ANTHROPIC_API_KEY"),
    falKey: req(env, "FAL_KEY"),
    botToken: req(env, "TELEGRAM_BOT_TOKEN"),
    allowlist: parseUserIds(env.TELEGRAM_ALLOWLIST),
  };
}

export function isUserAllowed(config: { allowlist: number[] }, userId: number): boolean {
  return config.allowlist.includes(userId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/config.test.ts` → PASS. Then `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat(telegram): config loader for bot token + numeric allowlist"
```

---

### Task 2: Per-user model preference store

**Files:**
- Create: `src/telegram-prefs.ts`
- Create: `test/telegram-prefs.test.ts`
- Modify: `.gitignore` (add `.state/`)

**Interfaces:**
- Produces:
  - `interface PrefsStore { get(userId: number): string | undefined; set(userId: number, modelId: string | null): void }`
  - `loadPrefsStore(filePath: string): PrefsStore` — persists JSON `{ "<userId>": "<modelId>" }`; `set(id, null)` clears; corrupt/missing file starts empty.

- [ ] **Step 1: Write the failing tests**

Create `test/telegram-prefs.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync, writeFileSync } from "node:fs";
import { loadPrefsStore } from "../src/telegram-prefs.js";

const FILE = ".state/test-prefs.json";

beforeEach(() => { if (existsSync(FILE)) rmSync(FILE); });
afterEach(() => { if (existsSync(FILE)) rmSync(FILE); });

describe("loadPrefsStore", () => {
  it("returns undefined for an unset user", () => {
    expect(loadPrefsStore(FILE).get(1)).toBeUndefined();
  });

  it("persists a set value across reloads", () => {
    loadPrefsStore(FILE).set(1, "flux2-pro");
    expect(loadPrefsStore(FILE).get(1)).toBe("flux2-pro");
  });

  it("clears a value when set to null", () => {
    const s = loadPrefsStore(FILE);
    s.set(1, "flux2-pro");
    s.set(1, null);
    expect(s.get(1)).toBeUndefined();
    expect(loadPrefsStore(FILE).get(1)).toBeUndefined();
  });

  it("starts empty on a corrupt file", () => {
    loadPrefsStore(FILE).set(1, "flux2-pro");
    writeFileSync(FILE, "not json{");
    expect(loadPrefsStore(FILE).get(1)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/telegram-prefs.test.ts`
Expected: FAIL — cannot find module `../src/telegram-prefs.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/telegram-prefs.ts`:

```ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface PrefsStore {
  get(userId: number): string | undefined;
  set(userId: number, modelId: string | null): void;
}

export function loadPrefsStore(filePath: string): PrefsStore {
  const map = new Map<number, string>();
  if (existsSync(filePath)) {
    try {
      const obj = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, string>;
      for (const [k, v] of Object.entries(obj)) map.set(Number(k), v);
    } catch {
      // corrupt or empty file: start fresh
    }
  }
  const persist = () => {
    mkdirSync(dirname(filePath), { recursive: true });
    const obj: Record<string, string> = {};
    for (const [k, v] of map) obj[String(k)] = v;
    writeFileSync(filePath, JSON.stringify(obj));
  };
  return {
    get: (userId) => map.get(userId),
    set: (userId, modelId) => {
      if (modelId === null) map.delete(userId);
      else map.set(userId, modelId);
      persist();
    },
  };
}
```

Add `.state/` to `.gitignore`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/telegram-prefs.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/telegram-prefs.ts test/telegram-prefs.test.ts .gitignore
git commit -m "feat(telegram): per-user model preference store"
```

---

### Task 3: Telegram API client (types + interface + fetch impl)

**Files:**
- Create: `src/telegram-client.ts`

**Interfaces:**
- Produces (imported by the handler and loop):
  - `interface TgPhotoSize { file_id: string; width: number; height: number; file_size?: number }`
  - `interface TgMessage { message_id: number; from?: { id: number; username?: string }; chat: { id: number }; text?: string; caption?: string; photo?: TgPhotoSize[] }`
  - `interface TgUpdate { update_id: number; message?: TgMessage }`
  - `interface TelegramApi { getUpdates(offset: number, timeoutSeconds: number): Promise<TgUpdate[]>; sendMessage(chatId: number, text: string): Promise<void>; sendPhoto(chatId: number, image: Buffer, caption: string): Promise<void>; getFileBuffer(fileId: string): Promise<Buffer> }`
  - `class TelegramClient implements TelegramApi` (constructor `(token: string)`)

**Testing note:** This module is thin glue over `fetch`. It is verified by `tsc --noEmit` and the live smoke test in Task 7, not by unit tests (the interface it defines is exercised through fakes in Tasks 4–6). This is a deliberate TDD exception for an untestable-in-isolation transport adapter.

- [ ] **Step 1: Create the module**

Create `src/telegram-client.ts`:

```ts
export interface TgPhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TgMessage {
  message_id: number;
  from?: { id: number; username?: string };
  chat: { id: number };
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

export interface TelegramApi {
  getUpdates(offset: number, timeoutSeconds: number): Promise<TgUpdate[]>;
  sendMessage(chatId: number, text: string): Promise<void>;
  sendPhoto(chatId: number, image: Buffer, caption: string): Promise<void>;
  getFileBuffer(fileId: string): Promise<Buffer>;
}

export class TelegramClient implements TelegramApi {
  constructor(private token: string) {}

  private base(): string {
    return `https://api.telegram.org/bot${this.token}`;
  }

  private async ok<T>(res: Response, what: string): Promise<T> {
    const body = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!body.ok) throw new Error(`${what} failed: ${body.description ?? res.status}`);
    return body.result as T;
  }

  async getUpdates(offset: number, timeoutSeconds: number): Promise<TgUpdate[]> {
    const res = await fetch(`${this.base()}/getUpdates?offset=${offset}&timeout=${timeoutSeconds}`);
    return this.ok<TgUpdate[]>(res, "getUpdates");
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    const res = await fetch(`${this.base()}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    await this.ok(res, "sendMessage");
  }

  async sendPhoto(chatId: number, image: Buffer, caption: string): Promise<void> {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("caption", caption);
    form.append("photo", new Blob([new Uint8Array(image)], { type: "image/jpeg" }), "result.jpg");
    const res = await fetch(`${this.base()}/sendPhoto`, { method: "POST", body: form });
    await this.ok(res, "sendPhoto");
  }

  async getFileBuffer(fileId: string): Promise<Buffer> {
    const res = await fetch(`${this.base()}/getFile?file_id=${fileId}`);
    const file = await this.ok<{ file_path: string }>(res, "getFile");
    const dl = await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`);
    if (!dl.ok) throw new Error(`file download failed: ${dl.status}`);
    return Buffer.from(await dl.arrayBuffer());
  }
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `npx tsc --noEmit`
Expected: clean (no errors).

- [ ] **Step 3: Commit**

```bash
git add src/telegram-client.ts
git commit -m "feat(telegram): raw-fetch Bot API client + TelegramApi interface"
```

---

### Task 4: Handler — access control + commands

**Files:**
- Create: `src/telegram-handler.ts`
- Create: `test/telegram-handler.test.ts`

**Interfaces:**
- Consumes: `TgUpdate`, `TelegramApi` (Task 3); `PrefsStore` (Task 2); `AnthropicLike` (`interpreter.ts`); `CATALOG`, `getModel` (`catalog.ts`).
- Produces:
  - `interface ProduceImageArgs { endpoint: string; prompt: string; inputImages?: Buffer[]; imageInput?: "image_url" | "image_urls" }`
  - `interface HandlerDeps { telegram: TelegramApi; anthropic: AnthropicLike; produceImage: (args: ProduceImageArgs) => Promise<Buffer>; allowlist: number[]; prefs: PrefsStore }`
  - `handleUpdate(update: TgUpdate, deps: HandlerDeps): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `test/telegram-handler.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { handleUpdate, type HandlerDeps } from "../src/telegram-handler.js";
import type { TgUpdate } from "../src/telegram-client.js";
import type { PrefsStore } from "../src/telegram-prefs.js";

function fakePrefs(initial: Record<number, string> = {}): PrefsStore {
  const m = new Map<number, string>(Object.entries(initial).map(([k, v]) => [Number(k), v]));
  return { get: (id) => m.get(id), set: (id, v) => { if (v === null) m.delete(id); else m.set(id, v); } };
}

function deps(over: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    telegram: {
      getUpdates: vi.fn(), sendMessage: vi.fn().mockResolvedValue(undefined),
      sendPhoto: vi.fn().mockResolvedValue(undefined), getFileBuffer: vi.fn().mockResolvedValue(Buffer.from("img")),
    },
    anthropic: { messages: { async create() { return { content: [{ type: "tool_use", name: "decide", input: { task: "generate", modelId: "flux-schnell", prompt: "a bike" } }] }; } } },
    produceImage: vi.fn().mockResolvedValue(Buffer.from("out")),
    allowlist: [111],
    prefs: fakePrefs(),
    ...over,
  };
}

function textUpdate(text: string, userId = 111): TgUpdate {
  return { update_id: 1, message: { message_id: 1, from: { id: userId }, chat: { id: 500 }, text } };
}

describe("handleUpdate — access & commands", () => {
  it("rejects a non-allowlisted user and echoes their id", async () => {
    const d = deps();
    await handleUpdate(textUpdate("hello", 999), d);
    expect(d.telegram.sendMessage).toHaveBeenCalledWith(500, expect.stringContaining("999"));
    expect(d.produceImage).not.toHaveBeenCalled();
  });

  it("/models lists catalog ids", async () => {
    const d = deps();
    await handleUpdate(textUpdate("/models"), d);
    expect(d.telegram.sendMessage).toHaveBeenCalledWith(500, expect.stringContaining("nano-banana-pro"));
  });

  it("/model <id> pins a valid model", async () => {
    const prefs = fakePrefs();
    const d = deps({ prefs });
    await handleUpdate(textUpdate("/model flux2-pro"), d);
    expect(prefs.get(111)).toBe("flux2-pro");
    expect(d.telegram.sendMessage).toHaveBeenCalledWith(500, expect.stringContaining("flux2-pro"));
  });

  it("/model auto clears the pin", async () => {
    const prefs = fakePrefs({ 111: "flux2-pro" });
    const d = deps({ prefs });
    await handleUpdate(textUpdate("/model auto"), d);
    expect(prefs.get(111)).toBeUndefined();
  });

  it("/model <unknown> is rejected without pinning", async () => {
    const prefs = fakePrefs();
    const d = deps({ prefs });
    await handleUpdate(textUpdate("/model nope"), d);
    expect(prefs.get(111)).toBeUndefined();
    expect(d.telegram.sendMessage).toHaveBeenCalledWith(500, expect.stringContaining("Unknown model"));
  });

  it("/whoami returns the numeric id", async () => {
    const d = deps();
    await handleUpdate(textUpdate("/whoami"), d);
    expect(d.telegram.sendMessage).toHaveBeenCalledWith(500, expect.stringContaining("111"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/telegram-handler.test.ts`
Expected: FAIL — cannot find module `../src/telegram-handler.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/telegram-handler.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/telegram-handler.test.ts` → PASS. Then `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/telegram-handler.ts test/telegram-handler.test.ts
git commit -m "feat(telegram): handler access control + /models, /model, /whoami commands"
```

---

### Task 5: Handler — generate/edit/clarify + interpreter copy

**Files:**
- Modify: `src/telegram-handler.ts` (fill the generation/edit path)
- Modify: `src/interpreter.ts:37` and `:40` (transport-neutral wording — behavior unchanged)
- Test: `test/telegram-handler.test.ts` (append)

**Interfaces:**
- Consumes: `interpret()`, `isValidChoice`, `getModel`, `type TaskType` (`catalog.ts`).
- Produces: same `handleUpdate` signature — now generates images.

- [ ] **Step 1: Write the failing tests**

Append to `test/telegram-handler.test.ts`:

```ts
function photoUpdate(caption: string, userId = 111): TgUpdate {
  return { update_id: 2, message: { message_id: 2, from: { id: userId }, chat: { id: 500 }, caption, photo: [{ file_id: "F1", width: 100, height: 100 }] } };
}
function anthropicReturning(input: unknown) {
  return { messages: { async create() { return { content: [{ type: "tool_use", name: "decide", input }] }; } } };
}

describe("handleUpdate — generation", () => {
  it("generates from a text message and captions with model + prompt", async () => {
    const d = deps();
    await handleUpdate(textUpdate("a bike"), d);
    expect(d.produceImage).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "fal-ai/flux/schnell", prompt: "a bike" }));
    const [chatId, image, caption] = (d.telegram.sendPhoto as any).mock.calls[0];
    expect(chatId).toBe(500);
    expect(image).toBeInstanceOf(Buffer);
    expect(caption).toContain("FLUX schnell");
    expect(caption).toContain("a bike");
  });

  it("edits a photo+caption, downloading the file and passing one input image", async () => {
    const d = deps({ anthropic: anthropicReturning({ task: "edit", modelId: "nano-banana-pro-edit", prompt: "make it night" }) });
    await handleUpdate(photoUpdate("make it night"), d);
    expect(d.telegram.getFileBuffer).toHaveBeenCalledWith("F1");
    expect(d.produceImage).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: "fal-ai/nano-banana-pro/edit", imageInput: "image_urls", inputImages: [Buffer.from("img")],
    }));
  });

  it("uses a pinned valid model over the auto pick", async () => {
    const d = deps({ prefs: fakePrefs({ 111: "recraft-v3" }) });
    await handleUpdate(textUpdate("a bike"), d);
    expect(d.produceImage).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "fal-ai/recraft-v3" }));
  });

  it("falls back to auto and notes it when the pinned model can't do the task", async () => {
    const d = deps({ anthropic: anthropicReturning({ task: "edit", modelId: "nano-banana-pro-edit", prompt: "night" }), prefs: fakePrefs({ 111: "flux-schnell" }) });
    await handleUpdate(photoUpdate("night"), d);
    expect(d.produceImage).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "fal-ai/nano-banana-pro/edit" }));
    const caption = (d.telegram.sendPhoto as any).mock.calls[0][2];
    expect(caption).toMatch(/used auto/i);
  });

  it("prompts for a caption when a photo has none", async () => {
    const d = deps();
    await handleUpdate({ update_id: 3, message: { message_id: 3, from: { id: 111 }, chat: { id: 500 }, photo: [{ file_id: "F1", width: 10, height: 10 }] } }, d);
    expect(d.telegram.sendMessage).toHaveBeenCalledWith(500, expect.stringContaining("caption"));
    expect(d.produceImage).not.toHaveBeenCalled();
  });

  it("replies the clarify question and does not generate", async () => {
    const d = deps({ anthropic: anthropicReturning({ task: "clarify", message: "What should I create?" }) });
    await handleUpdate(textUpdate("hmm"), d);
    expect(d.telegram.sendMessage).toHaveBeenCalledWith(500, "What should I create?");
    expect(d.produceImage).not.toHaveBeenCalled();
  });

  it("sends a friendly error when generation throws", async () => {
    const d = deps({ produceImage: vi.fn().mockRejectedValue(new Error("boom")) });
    await handleUpdate(textUpdate("a bike"), d);
    expect(d.telegram.sendMessage).toHaveBeenCalledWith(500, expect.stringMatching(/failed/i));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/telegram-handler.test.ts`
Expected: FAIL — new "generation" tests fail (photo-no-caption currently falls through; generate path not implemented → `sendPhoto`/`getFileBuffer` never called).

- [ ] **Step 3: Write minimal implementation**

In `src/telegram-handler.ts`, update the imports line:

```ts
import { CATALOG, getModel, isValidChoice, type TaskType } from "./catalog.js";
```

Replace the `// Generation/edit path added in Task 5.` comment with:

```ts
  const photo = msg.photo && msg.photo.length > 0 ? msg.photo[msg.photo.length - 1] : undefined;
  if (photo && !rawText) {
    await deps.telegram.sendMessage(chatId, "Add a caption describing the edit.");
    return;
  }

  let decision;
  try {
    decision = await interpret(deps.anthropic, { text: rawText, hasImage: !!photo });
  } catch (err) {
    console.error(`user=${userId} interpret failed:`, err);
    await deps.telegram.sendMessage(chatId, "Sorry — I couldn't understand that. Please rephrase and try again.");
    return;
  }

  if (decision.task === "clarify") {
    await deps.telegram.sendMessage(chatId, decision.message);
    return;
  }

  const pinned = deps.prefs.get(userId);
  let modelId = decision.modelId;
  let note = "";
  if (pinned) {
    if (isValidChoice(pinned, decision.task as TaskType)) modelId = pinned;
    else note = ` (pinned ${pinned} can't ${decision.task} — used auto)`;
  }
  const model = getModel(modelId)!;

  const started = Date.now();
  try {
    let inputImages: Buffer[] | undefined;
    if (decision.task === "edit" && photo) {
      inputImages = [await deps.telegram.getFileBuffer(photo.file_id)];
    }
    const image = await deps.produceImage({
      endpoint: model.endpoint,
      prompt: decision.prompt,
      inputImages,
      imageInput: model.imageInput,
    });
    const emoji = decision.task === "edit" ? "✏️" : "🎨";
    await deps.telegram.sendPhoto(chatId, image, `${emoji} ${model.label} · ${decision.prompt}${note}`);
    console.log(
      `user=${userId} task=${decision.task} model=${model.id} pinned=${pinned ?? "auto"} ` +
        `prompt=${JSON.stringify(decision.prompt)} ok ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
  } catch (err) {
    console.error(`user=${userId} generation failed:`, err);
    await deps.telegram.sendMessage(chatId, "Sorry — that request failed to generate. Please try again.");
  }
```

Then update `src/interpreter.ts` copy (behavior-neutral): change line 37 `"You route image-creation and image-editing requests sent by email."` to `"You route image-creation and image-editing requests from users."` and line 40 `"If an image is attached, prefer an 'edit' model; if none is attached, you cannot edit, so use 'generate' or 'clarify'."` — keep as-is (already transport-neutral). Only the "sent by email" phrase changes.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/telegram-handler.test.ts` → PASS. Then `npx vitest run && npx tsc --noEmit` → all green.

- [ ] **Step 5: Commit**

```bash
git add src/telegram-handler.ts src/interpreter.ts test/telegram-handler.test.ts
git commit -m "feat(telegram): generate/edit/clarify flow with pinned-model fallback + captions"
```

---

### Task 6: Long-poll loop

**Files:**
- Create: `src/telegram-loop.ts`
- Create: `test/telegram-loop.test.ts`

**Interfaces:**
- Consumes: `handleUpdate`, `HandlerDeps` (Task 4/5); `TgUpdate` (Task 3).
- Produces: `runTelegramLoop(deps: HandlerDeps, shouldStop: () => boolean, pollTimeoutSeconds?: number, handle?: typeof handleUpdate): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `test/telegram-loop.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { runTelegramLoop } from "../src/telegram-loop.js";
import type { HandlerDeps } from "../src/telegram-handler.js";
import type { TgUpdate } from "../src/telegram-client.js";

function depsWith(getUpdates: any): HandlerDeps {
  return {
    telegram: { getUpdates, sendMessage: vi.fn(), sendPhoto: vi.fn(), getFileBuffer: vi.fn() },
    anthropic: { messages: { create: vi.fn() } }, produceImage: vi.fn(),
    allowlist: [111], prefs: { get: () => undefined, set: () => {} },
  };
}

const u = (id: number): TgUpdate => ({ update_id: id, message: { message_id: id, from: { id: 111 }, chat: { id: 1 }, text: "hi" } });

describe("runTelegramLoop", () => {
  it("processes each update once and advances the offset past the last update_id", async () => {
    const getUpdates = vi.fn()
      .mockResolvedValueOnce([u(10), u(11)])
      .mockResolvedValue([]);
    const d = depsWith(getUpdates);
    const handle = vi.fn().mockResolvedValue(undefined);
    let calls = 0;
    await runTelegramLoop(d, () => ++calls > 2, 0, handle);
    expect(handle).toHaveBeenCalledTimes(2);
    // second getUpdates call uses offset = 12 (11 + 1)
    expect(getUpdates.mock.calls[1][0]).toBe(12);
  });

  it("keeps going when a handler throws", async () => {
    const getUpdates = vi.fn().mockResolvedValueOnce([u(10), u(11)]).mockResolvedValue([]);
    const d = depsWith(getUpdates);
    const handle = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    let calls = 0;
    await runTelegramLoop(d, () => ++calls > 2, 0, handle);
    expect(handle).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/telegram-loop.test.ts`
Expected: FAIL — cannot find module `../src/telegram-loop.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/telegram-loop.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/telegram-loop.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/telegram-loop.ts test/telegram-loop.test.ts
git commit -m "feat(telegram): long-poll loop with offset advance and per-update isolation"
```

---

### Task 7: Composition root, entrypoint rename, scripts, Dockerfile

**Files:**
- Create: `src/telegram-index.ts`
- Rename: `src/index.ts` → `src/email-index.ts`
- Modify: `package.json` (scripts)
- Modify: `Dockerfile` (CMD)

**Interfaces:**
- Consumes: `loadTelegramConfig` (Task 1), `TelegramClient` (Task 3), `loadPrefsStore` (Task 2), `runTelegramLoop` (Task 6), `runModel`/`FalLike` (`fal-runner.ts`), `downloadImage`/`toLowRes` (`image.ts`).

**Testing note:** Composition roots are wiring; verified by `tsc`, the full suite, and the live smoke test below — not unit-tested.

- [ ] **Step 1: Rename the email entrypoint**

Run: `git mv src/index.ts src/email-index.ts`
Then confirm nothing imports it: `grep -rn "index.js\"" src/ test/` → expect no hits referencing the composition root.

- [ ] **Step 2: Create the Telegram composition root**

Create `src/telegram-index.ts`:

```ts
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { fal } from "@fal-ai/client";
import { loadTelegramConfig } from "./config.js";
import { TelegramClient } from "./telegram-client.js";
import { loadPrefsStore } from "./telegram-prefs.js";
import { runModel, type FalLike } from "./fal-runner.js";
import { downloadImage, toLowRes } from "./image.js";
import { runTelegramLoop } from "./telegram-loop.js";

const config = loadTelegramConfig(process.env);
fal.config({ credentials: config.falKey });
const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
const telegram = new TelegramClient(config.botToken);
const prefs = loadPrefsStore(".state/telegram-prefs.json");

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
  { telegram, anthropic, produceImage, allowlist: config.allowlist, prefs },
  () => false,
);
```

- [ ] **Step 3: Update package.json scripts**

In `package.json`, set:

```json
    "dev": "tsx src/telegram-index.ts",
    "dev:email": "tsx src/email-index.ts",
    "start": "node dist/telegram-index.js",
```

(Leave `build`, `auth`, `docker:build`, `release`, `test` unchanged.)

- [ ] **Step 4: Update Dockerfile CMD**

In `Dockerfile`, change the runtime command to:

```dockerfile
CMD ["node", "dist/telegram-index.js"]
```

- [ ] **Step 5: Verify build + full suite**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: tsc clean, all tests pass, `dist/telegram-index.js` produced.

- [ ] **Step 6: Live smoke test (manual, operator)**

With `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALLOWLIST` (your numeric id) in `.env`:
Run: `npm run dev`
In Telegram: message the bot `/whoami` (expect your id), `a red apple on a white table` (expect an image with caption `🎨 … · a red apple…`), then send a photo with caption `make it night` (expect an edited image). Confirm one console log line per generation.

- [ ] **Step 7: Commit**

```bash
git add src/telegram-index.ts src/email-index.ts package.json Dockerfile
git commit -m "feat(telegram): composition root, entrypoint switch, scripts, Docker CMD"
```

---

### Task 8: Documentation (env, README, DEPLOY)

**Files:**
- Modify: `.env.example`, `README.md`, `DEPLOY.md`

**Testing note:** Docs task — verified by review against the code; no automated test.

- [ ] **Step 1: Update `.env.example`**

Add a Telegram section (keep existing vars for the dormant email flow):

```
# --- Telegram bot (active transport) ---
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...        # from @BotFather
TELEGRAM_ALLOWLIST=111111111,222222222      # comma-separated numeric Telegram user ids
```

- [ ] **Step 2: Update `README.md`**

Add a "Telegram bot" section: create a bot with @BotFather, put the token in `TELEGRAM_BOT_TOKEN`; get your numeric id by messaging the bot (`/whoami`, or any message when not yet allow-listed — it echoes your id) and add it to `TELEGRAM_ALLOWLIST`; `npm run dev` to run; usage (text = generate, photo+caption = edit, `/models`, `/model <id>`, `/model auto`). Note the email flow is now `npm run dev:email` and dormant.

- [ ] **Step 3: Update `DEPLOY.md`**

Note the production entrypoint is `dist/telegram-index.js` (Docker CMD updated); env now needs `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALLOWLIST` (Anthropic/Fal unchanged); no inbound ports (long polling); add a persistent volume at `/app/.state` for per-user model prefs; the `.processed` volume is not used by the Telegram transport.

- [ ] **Step 4: Commit**

```bash
git add .env.example README.md DEPLOY.md
git commit -m "docs(telegram): env, README usage, and DEPLOY runbook for the bot"
```

---

## Self-Review

**Spec coverage:**
- Reused core unchanged → Tasks 4–5 import `interpret`/`catalog`/`fal-runner`/`image`; only copy tweak in Task 5. ✓
- `telegram-client` / `telegram-handler` / `telegram-loop` / `telegram-prefs` / `telegram-index` → Tasks 3, 4+5, 6, 2, 7. ✓
- Per-user model pinning (`/models`, `/model`) → Tasks 2, 4. ✓
- Auto with pinned-if-valid fallback + note → Task 5. ✓
- User-id allowlist + echo id → Tasks 1, 4. ✓
- Model + prompt in caption + console log line → Task 5. ✓
- Config split (Telegram config separate; email untouched) → Task 1. ✓
- Entrypoint rename + scripts + Docker + `.state` volume → Tasks 2, 7, 8. ✓
- Single-image v1 → Task 5 (`inputImages = [one]`). ✓
- Long polling, offset ack, no dedup store → Task 6. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. ✓

**Type consistency:** `HandlerDeps`, `ProduceImageArgs`, `TelegramApi`, `TgUpdate`, `PrefsStore`, `loadTelegramConfig`/`isUserAllowed`, `loadPrefsStore`, `runTelegramLoop` names/signatures match across tasks. `imageInput`/`inputImages` match `fal-runner.ts` (`RunArgs`). ✓
