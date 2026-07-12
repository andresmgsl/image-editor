# Reference Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users name known people and La Familia brand assets in a request so the bot auto-injects their reference images into a multi-image model.

**Architecture:** A repo-baked `assets/library.json` manifest + images is loaded once at startup into a `ReferenceLibrary`. The interpreter learns the library and returns `references: string[]` (library ids). A pure routing helper gathers `[userImages, refImages]`, enforces an image-capable model (array-image model when ≥2 images, default Nano Banana Pro Edit), and both transports (Telegram + email) call it before `produceImage`.

**Tech Stack:** Node.js 20 + TypeScript (strict, ESM), Zod, Vitest. Fal.ai image models via existing `runModel`. Anthropic `claude-opus-4-8` for routing.

## Global Constraints

- ESM everywhere: import paths end in `.js` even for `.ts` sources (e.g. `./catalog.js`).
- TypeScript strict; `npm run build` (=`tsc --noEmit` per project) must stay clean.
- Tests: Vitest, all collaborators mocked (no live fal/anthropic/network calls).
- Default routing model floor for multi-image is `nano-banana-pro-edit`; never remove entries from `src/catalog.ts`.
- Reference-image conditioning only — no model training / LoRA.
- Reference images are baked into the repo under `assets/`; do not add runtime asset storage.
- Commit message trailer for every commit:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```

---

### Task 1: Reference library module

**Files:**
- Create: `src/reference-library.ts`
- Create: `test/reference-library.test.ts`
- Create fixture: `test/fixtures/reflib/library.json`
- Create fixture images: `test/fixtures/reflib/people/andres/1.jpg`, `test/fixtures/reflib/people/andres/2.jpg`, `test/fixtures/reflib/brand/shirt/front.jpg`

**Interfaces:**
- Produces:
  - `interface ReferenceEntry { id: string; kind: "person" | "brand"; name: string; aliases: string[]; description: string; images: string[] }`
  - `interface ReferenceLibrary { entries: ReferenceEntry[]; resolveImages(ids: string[]): Buffer[] }`
  - `function loadReferenceLibrary(rootDir: string): ReferenceLibrary`

- [ ] **Step 1: Create the test fixture manifest and images**

Create `test/fixtures/reflib/library.json`:

```json
[
  {
    "id": "andres",
    "kind": "person",
    "name": "Andrés",
    "aliases": ["andres"],
    "description": "Andrés, team member",
    "images": ["people/andres/1.jpg", "people/andres/2.jpg"]
  },
  {
    "id": "shirt",
    "kind": "brand",
    "name": "Official La Familia shirt",
    "aliases": ["camiseta oficial", "official shirt"],
    "description": "The official La Familia Solana t-shirt",
    "images": ["brand/shirt/front.jpg"]
  }
]
```

Create the three fixture image files (content is irrelevant to unit tests — they only need to exist and be readable):

```bash
mkdir -p test/fixtures/reflib/people/andres test/fixtures/reflib/brand/shirt
printf 'andres-1' > test/fixtures/reflib/people/andres/1.jpg
printf 'andres-2' > test/fixtures/reflib/people/andres/2.jpg
printf 'shirt-front' > test/fixtures/reflib/brand/shirt/front.jpg
```

- [ ] **Step 2: Write the failing tests**

Create `test/reference-library.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { loadReferenceLibrary } from "../src/reference-library.js";

const FIXTURE = "test/fixtures/reflib";

describe("loadReferenceLibrary", () => {
  it("loads and validates the manifest", () => {
    const lib = loadReferenceLibrary(FIXTURE);
    expect(lib.entries.map((e) => e.id)).toEqual(["andres", "shirt"]);
    expect(lib.entries[0].kind).toBe("person");
  });

  it("resolves images to buffers in reference order across entries", () => {
    const lib = loadReferenceLibrary(FIXTURE);
    const bufs = lib.resolveImages(["andres", "shirt"]);
    expect(bufs.map((b) => b.toString())).toEqual(["andres-1", "andres-2", "shirt-front"]);
  });

  it("drops unknown ids without throwing", () => {
    const lib = loadReferenceLibrary(FIXTURE);
    const bufs = lib.resolveImages(["nope", "shirt"]);
    expect(bufs.map((b) => b.toString())).toEqual(["shirt-front"]);
  });

  it("returns an empty library when the manifest is absent", () => {
    const lib = loadReferenceLibrary("test/fixtures/does-not-exist");
    expect(lib.entries).toEqual([]);
    expect(lib.resolveImages(["andres"])).toEqual([]);
  });

  it("throws when a referenced image file is missing", () => {
    expect(() => loadReferenceLibrary("test/fixtures/reflib-missing-image")).toThrow(/missing image/i);
  });

  it("throws when two entries share an id", () => {
    expect(() => loadReferenceLibrary("test/fixtures/reflib-dup-id")).toThrow(/duplicate id/i);
  });
});
```

Create the two extra fixtures the error tests need:

```bash
# missing-image fixture: manifest points at a file that does not exist
mkdir -p test/fixtures/reflib-missing-image
printf '[{"id":"x","kind":"brand","name":"X","aliases":[],"description":"","images":["nope.jpg"]}]' \
  > test/fixtures/reflib-missing-image/library.json

# duplicate-id fixture
mkdir -p test/fixtures/reflib-dup-id/a test/fixtures/reflib-dup-id/b
printf 'a' > test/fixtures/reflib-dup-id/a/1.jpg
printf 'b' > test/fixtures/reflib-dup-id/b/1.jpg
printf '[{"id":"dup","kind":"brand","name":"A","aliases":[],"description":"","images":["a/1.jpg"]},{"id":"dup","kind":"brand","name":"B","aliases":[],"description":"","images":["b/1.jpg"]}]' \
  > test/fixtures/reflib-dup-id/library.json
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/reference-library.test.ts`
Expected: FAIL — `loadReferenceLibrary` is not defined / module not found.

- [ ] **Step 4: Implement the module**

Create `src/reference-library.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export interface ReferenceEntry {
  id: string;
  kind: "person" | "brand";
  name: string;
  aliases: string[];
  description: string;
  images: string[];
}

export interface ReferenceLibrary {
  entries: ReferenceEntry[];
  /** Reference-image buffers for the given ids, in id order then image order. Unknown ids are skipped. */
  resolveImages(ids: string[]): Buffer[];
}

const EntrySchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["person", "brand"]),
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  description: z.string().default(""),
  images: z.array(z.string().min(1)).min(1),
});
const ManifestSchema = z.array(EntrySchema);

const EMPTY: ReferenceLibrary = { entries: [], resolveImages: () => [] };

export function loadReferenceLibrary(rootDir: string): ReferenceLibrary {
  const manifestPath = join(rootDir, "library.json");
  if (!existsSync(manifestPath)) {
    console.log(`Reference library: no manifest at ${manifestPath}; running with an empty library.`);
    return EMPTY;
  }

  const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entries = ManifestSchema.parse(raw) as ReferenceEntry[];

  const seen = new Set<string>();
  const buffers = new Map<string, Buffer[]>();
  for (const entry of entries) {
    if (seen.has(entry.id)) throw new Error(`Reference library: duplicate id "${entry.id}"`);
    seen.add(entry.id);
    const bufs: Buffer[] = [];
    for (const rel of entry.images) {
      const abs = join(rootDir, rel);
      if (!existsSync(abs)) throw new Error(`Reference library: missing image "${rel}" for id "${entry.id}"`);
      bufs.push(readFileSync(abs));
    }
    buffers.set(entry.id, bufs);
  }

  return {
    entries,
    resolveImages(ids: string[]): Buffer[] {
      const out: Buffer[] = [];
      for (const id of ids) {
        const bufs = buffers.get(id);
        if (!bufs) {
          console.warn(`Reference library: unknown id "${id}" requested; skipping.`);
          continue;
        }
        out.push(...bufs);
      }
      return out;
    },
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/reference-library.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/reference-library.ts test/reference-library.test.ts test/fixtures
git commit -m "feat(reflib): load & validate the reference-asset library

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Catalog helpers + routing resolver

**Files:**
- Modify: `src/catalog.ts` (append two helpers after `defaultModelFor`)
- Create: `src/reference-routing.ts`
- Create: `test/reference-routing.test.ts`

**Interfaces:**
- Consumes: `CatalogModel`, `getModel`, `defaultModelFor` from `./catalog.js`.
- Produces (catalog):
  - `function isArrayImageModel(m: CatalogModel): boolean`
  - `function defaultMultiReferenceModel(): CatalogModel`
- Produces (routing):
  - `const MAX_INJECTED_IMAGES = 8`
  - `interface ResolveGenArgs { chosenModelId: string; userImages: Buffer[]; refImages: Buffer[] }`
  - `interface ResolvedGen { model: CatalogModel; images: Buffer[]; overrideNote: string; droppedCount: number }`
  - `function resolveGeneration(args: ResolveGenArgs): ResolvedGen`

- [ ] **Step 1: Write the failing tests**

Create `test/reference-routing.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveGeneration, MAX_INJECTED_IMAGES } from "../src/reference-routing.js";

const buf = (s: string) => Buffer.from(s);

describe("resolveGeneration", () => {
  it("keeps the chosen text model when there are no images", () => {
    const r = resolveGeneration({ chosenModelId: "flux-schnell", userImages: [], refImages: [] });
    expect(r.model.id).toBe("flux-schnell");
    expect(r.images).toEqual([]);
    expect(r.overrideNote).toBe("");
  });

  it("orders user images before reference images", () => {
    const r = resolveGeneration({
      chosenModelId: "seedream-edit",
      userImages: [buf("user")],
      refImages: [buf("ref1"), buf("ref2")],
    });
    expect(r.images.map((b) => b.toString())).toEqual(["user", "ref1", "ref2"]);
  });

  it("overrides a text model to nano-banana-pro-edit when a single reference image is present", () => {
    const r = resolveGeneration({ chosenModelId: "flux-schnell", userImages: [], refImages: [buf("a")] });
    expect(r.model.id).toBe("nano-banana-pro-edit");
    expect(r.overrideNote).not.toBe("");
  });

  it("keeps a single-image edit model when exactly one image is present", () => {
    const r = resolveGeneration({ chosenModelId: "flux-kontext-max", userImages: [buf("a")], refImages: [] });
    expect(r.model.id).toBe("flux-kontext-max");
    expect(r.overrideNote).toBe("");
  });

  it("overrides a single-image edit model to nano-banana-pro-edit when 2+ images are present", () => {
    const r = resolveGeneration({ chosenModelId: "flux-kontext-max", userImages: [buf("a"), buf("b")], refImages: [] });
    expect(r.model.id).toBe("nano-banana-pro-edit");
    expect(r.overrideNote).not.toBe("");
  });

  it("keeps an array-image model when 2+ images are present", () => {
    const r = resolveGeneration({ chosenModelId: "seedream-edit", userImages: [buf("a")], refImages: [buf("b")] });
    expect(r.model.id).toBe("seedream-edit");
    expect(r.overrideNote).toBe("");
  });

  it("trims injected images to the cap and reports the dropped count", () => {
    const many = Array.from({ length: MAX_INJECTED_IMAGES + 3 }, (_, i) => buf(`i${i}`));
    const r = resolveGeneration({ chosenModelId: "seedream-edit", userImages: many, refImages: [] });
    expect(r.images.length).toBe(MAX_INJECTED_IMAGES);
    expect(r.droppedCount).toBe(3);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/reference-routing.test.ts`
Expected: FAIL — `resolveGeneration` not defined.

- [ ] **Step 3: Add the catalog helpers**

In `src/catalog.ts`, append after `defaultModelFor` (end of file):

```ts
/** True for edit models that accept an array of input images (`image_urls`). */
export function isArrayImageModel(m: CatalogModel): boolean {
  return m.imageInput === "image_urls";
}

/** Default engine for multi-reference injection (best subject consistency). */
export function defaultMultiReferenceModel(): CatalogModel {
  return getModel("nano-banana-pro-edit")!;
}
```

- [ ] **Step 4: Implement the routing resolver**

Create `src/reference-routing.ts`:

```ts
import {
  getModel,
  isArrayImageModel,
  defaultMultiReferenceModel,
  type CatalogModel,
} from "./catalog.js";

/** Upper bound on images sent to fal in one call — a cost guard. */
export const MAX_INJECTED_IMAGES = 8;

export interface ResolveGenArgs {
  /** Model id chosen by the interpreter or pinned by the user. */
  chosenModelId: string;
  /** Images the user attached (0+). Placed first. */
  userImages: Buffer[];
  /** Reference-library images already resolved, in reference order. */
  refImages: Buffer[];
}

export interface ResolvedGen {
  model: CatalogModel;
  /** Final ordered image list (may be empty). */
  images: Buffer[];
  /** User-facing note when the model was overridden for image capability; "" otherwise. */
  overrideNote: string;
  /** How many images were dropped by the cap. */
  droppedCount: number;
}

/**
 * Turn a chosen model + gathered images into a concrete, image-capable call.
 * With 2+ images the model must accept an `image_urls` array; otherwise it is
 * overridden to the default multi-reference model. With exactly one image any
 * edit model is fine; a text-only model is overridden. With zero images the
 * chosen model is kept as-is (plain text-to-image).
 */
export function resolveGeneration(args: ResolveGenArgs): ResolvedGen {
  let images = [...args.userImages, ...args.refImages];
  let droppedCount = 0;
  if (images.length > MAX_INJECTED_IMAGES) {
    droppedCount = images.length - MAX_INJECTED_IMAGES;
    // No silent truncation — always report a trimmed image set.
    console.warn(`resolveGeneration: dropped ${droppedCount} image(s) over the ${MAX_INJECTED_IMAGES} cap.`);
    images = images.slice(0, MAX_INJECTED_IMAGES);
  }

  const chosen = getModel(args.chosenModelId);
  const count = images.length;

  const capable =
    !!chosen &&
    (count === 0
      ? true
      : count === 1
        ? !!chosen.imageInput // any edit model
        : isArrayImageModel(chosen)); // 2+ needs an array-image model

  if (capable) {
    return { model: chosen!, images, overrideNote: "", droppedCount };
  }

  const model = defaultMultiReferenceModel();
  const overrideNote = ` (used ${model.label} — needs input images)`;
  return { model, images, overrideNote, droppedCount };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/reference-routing.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add src/catalog.ts src/reference-routing.ts test/reference-routing.test.ts
git commit -m "feat(routing): resolveGeneration picks an image-capable model for references

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Interpreter — references field + library prompt

**Files:**
- Modify: `src/interpreter.ts`
- Modify: `test/interpreter.test.ts` (existing `toEqual` assertions gain `references: []`; add reference tests)

**Interfaces:**
- Consumes: `ReferenceEntry` from `./reference-library.js` (type-only).
- Produces:
  - `Decision` generate/edit variants now include `references: string[]`.
  - `interpret(client, input: { text: string; hasImage: boolean; library?: ReferenceEntry[] })` — new optional `library`.

- [ ] **Step 1: Update the failing tests**

In `test/interpreter.test.ts`, update the two `toEqual` assertions that expect a generate result to include `references: []`:

- Line ~19: `expect(d).toEqual({ task: "generate", modelId: "flux-schnell", prompt: "a red bike", references: [] });`
- Line ~54: `expect(d).toEqual({ task: "generate", modelId: "flux-schnell", prompt: "a red bike", references: [] });`

Then add two new tests inside the `describe("interpret", ...)` block:

```ts
  it("passes references through when the model names library entries", async () => {
    const client = fakeClient({
      task: "generate",
      modelId: "nano-banana-pro",
      prompt: "the person shown wearing the shirt in a square",
      references: ["andres", "shirt"],
    });
    const d = await interpret(client, {
      text: "andres with the official shirt in a square",
      hasImage: false,
      library: [
        { id: "andres", kind: "person", name: "Andrés", aliases: [], description: "", images: ["a.jpg"] },
        { id: "shirt", kind: "brand", name: "Shirt", aliases: [], description: "", images: ["s.jpg"] },
      ],
    });
    if (d.task !== "clarify") expect(d.references).toEqual(["andres", "shirt"]);
  });

  it("defaults references to [] when the model omits them", async () => {
    const client = fakeClient({ task: "generate", modelId: "flux-schnell", prompt: "a red bike" });
    const d = await interpret(client, { text: "a red bike", hasImage: false });
    if (d.task !== "clarify") expect(d.references).toEqual([]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/interpreter.test.ts`
Expected: FAIL — results lack `references`; `interpret` doesn't accept `library`.

- [ ] **Step 3: Implement the interpreter changes**

In `src/interpreter.ts`:

Add a type-only import at the top (after the existing catalog import):

```ts
import type { ReferenceEntry } from "./reference-library.js";
```

Replace `DecisionSchema` with the reference-aware version:

```ts
export const DecisionSchema = z.discriminatedUnion("task", [
  z.object({ task: z.literal("clarify"), message: z.string().min(1) }),
  z.object({
    task: z.literal("generate"),
    modelId: z.string(),
    prompt: z.string().min(1),
    references: z.array(z.string()).default([]),
  }),
  z.object({
    task: z.literal("edit"),
    modelId: z.string(),
    prompt: z.string().min(1),
    references: z.array(z.string()).default([]),
  }),
]);
```

Add a `references` property to `DECIDE_TOOL.input_schema.properties` (after `message`):

```ts
      references: {
        type: "array",
        items: { type: "string" },
        description:
          "Reference-library ids to inject (people/brand assets named in the request). Omit or [] if none.",
      },
```

Add a library-rendering helper above `systemPrompt`:

```ts
function librarySection(library: ReferenceEntry[]): string {
  if (library.length === 0) return "";
  const lines = library
    .map((e) => {
      const aka = e.aliases.length ? ` (aka ${e.aliases.join(", ")})` : "";
      const desc = e.description ? ` — ${e.description}` : "";
      return `- ${e.id} [${e.kind}]: ${e.name}${aka}${desc}`;
    })
    .join("\n");
  return [
    "",
    "Reference library — known people and brand assets you can inject by id:",
    lines,
    "When the request names any of these, put their id(s) in `references`. Their images",
    "are added automatically; write the prompt describing the scene naturally (e.g. 'the",
    "person shown wearing the shirt'). References do NOT require the user to attach an",
    "image — only choose task 'edit' when the USER attached an image to modify.",
  ].join("\n");
}
```

Change `systemPrompt` to take the library and append the section:

```ts
function systemPrompt(library: ReferenceEntry[]): string {
  const lines = CATALOG.map((m) => `- ${m.id} (${m.task}): ${m.description}`).join("\n");
  return [
    "You route image-creation and image-editing requests from users.",
    "Decide whether the request is a text-to-image generation, an edit of an attached image, or too unclear to act on.",
    "Pick the single best model from this catalog by its id, and write a clean, specific prompt for that model.",
    "If an image is attached, prefer an 'edit' model; if none is attached, you cannot edit, so use 'generate' or 'clarify'.",
    "Encode any framing or aspect ratio the user asks for (e.g. 'wide 16:9 banner') directly in the prompt text.",
    "If the request is empty or too vague to act on, use task 'clarify' and ask a short question.",
    "",
    "Catalog:",
    lines,
    librarySection(library),
  ].join("\n");
}
```

Update the `interpret` signature and the `system:` argument:

```ts
export async function interpret(
  client: AnthropicLike,
  input: { text: string; hasImage: boolean; library?: ReferenceEntry[] },
): Promise<Decision> {
```

and inside the loop, change the create call's system field:

```ts
      system: systemPrompt(input.library ?? []),
```

(The rest of `interpret` — retry loop, validation, `isValidChoice` fallback — is unchanged.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/interpreter.test.ts`
Expected: PASS (all, including the two new tests).

- [ ] **Step 5: Commit**

```bash
git add src/interpreter.ts test/interpreter.test.ts
git commit -m "feat(interpreter): references field + reference-library prompt section

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Wire the Telegram handler

**Files:**
- Modify: `src/telegram-handler.ts`
- Modify: `test/telegram-handler.test.ts`

**Interfaces:**
- Consumes: `resolveGeneration` from `./reference-routing.js`; `ReferenceLibrary` from `./reference-library.js`.
- Produces: `HandlerDeps` gains `library: ReferenceLibrary`.

- [ ] **Step 1: Update the test helper and add reference tests**

In `test/telegram-handler.test.ts`, add `library` to the `deps()` helper's returned object (after `prefs: fakePrefs()`):

```ts
    library: { entries: [], resolveImages: () => [] },
```

Add these tests to the file (new `describe` block at the end):

```ts
describe("handleUpdate — references", () => {
  function anthropicRef(references: string[]): HandlerDeps["anthropic"] {
    return {
      messages: {
        async create() {
          return {
            content: [
              {
                type: "tool_use",
                name: "decide",
                input: { task: "generate", modelId: "nano-banana-pro", prompt: "a scene", references },
              },
            ],
          };
        },
      },
    };
  }

  it("injects reference images and overrides to an array-image model", async () => {
    const refBufs = [Buffer.from("andres1"), Buffer.from("andres2")];
    const d = deps({
      anthropic: anthropicRef(["andres"]),
      library: { entries: [], resolveImages: () => refBufs },
    });
    await handleUpdate(textUpdate("an image of andres"), d);
    expect(d.produceImage).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "fal-ai/nano-banana-pro/edit",
        inputImages: refBufs,
        imageInput: "image_urls",
      }),
    );
  });

  it("does not fetch a user file when no image is attached", async () => {
    const d = deps({
      anthropic: anthropicRef(["andres"]),
      library: { entries: [], resolveImages: () => [Buffer.from("x")] },
    });
    await handleUpdate(textUpdate("an image of andres"), d);
    expect(d.telegram.getFileBuffer).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/telegram-handler.test.ts`
Expected: FAIL — `library` missing on `HandlerDeps` type / injection path not implemented.

- [ ] **Step 3: Implement the handler changes**

In `src/telegram-handler.ts`:

Add imports (top of file, with the others), and add `type CatalogModel` to the existing catalog import:

```ts
import { CATALOG, getModel, isValidChoice, type CatalogModel } from "./catalog.js";
import { resolveGeneration } from "./reference-routing.js";
import type { ReferenceLibrary } from "./reference-library.js";
```

Add `library` to `HandlerDeps`:

```ts
export interface HandlerDeps {
  telegram: TelegramApi;
  anthropic: AnthropicLike;
  produceImage: (args: ProduceImageArgs) => Promise<Buffer>;
  allowlist: number[];
  prefs: PrefsStore;
  library: ReferenceLibrary;
}
```

Pass the library into `interpret` (the existing call near line 147):

```ts
    decision = await interpret(deps.anthropic, {
      text: rawText,
      hasImage: !!imageFileId,
      library: deps.library.entries,
    });
```

Replace the model-selection + generation block — everything from `const pinned = deps.prefs.get(userId);` through the end of `handleUpdate` (the current lines ~168–205, including the old `logSuffix`, try/catch, caption, `sendPhoto`, and final `console.log`) — with:

```ts
  const pinned = deps.prefs.get(userId);
  let modelId = decision.modelId;
  let note = "";
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
    const refImages = deps.library.resolveImages(decision.references);
    const resolved = resolveGeneration({ chosenModelId: modelId, userImages, refImages });
    model = resolved.model;
    note += resolved.overrideNote;
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
  await deps.telegram.sendPhoto(chatId, image, caption);
  console.log(
    `user=${userId} task=${decision.task} model=${model.id} pinned=${pinned ?? "auto"} ` +
      `refs=${JSON.stringify(decision.references)} ok ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
```

Note: the old `logSuffix` closure and the separate `getFileBuffer` call are removed — image fetching now happens inside the try block above. Delete the now-unused old block entirely so there is no duplicate `started`/`image` declaration.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/telegram-handler.test.ts`
Expected: PASS (all existing + 2 new).

- [ ] **Step 5: Verify the whole suite + build still pass**

Run: `npx vitest run && npm run build`
Expected: all tests PASS, build clean.

- [ ] **Step 6: Commit**

```bash
git add src/telegram-handler.ts test/telegram-handler.test.ts
git commit -m "feat(telegram): inject reference images before generation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Wire the email orchestrator

**Files:**
- Modify: `src/orchestrator.ts`
- Modify: `test/orchestrator.test.ts`

**Interfaces:**
- Consumes: `resolveGeneration` from `./reference-routing.js`; `ReferenceLibrary` from `./reference-library.js`.
- Produces: `OrchestratorDeps` gains `library: ReferenceLibrary`.

- [ ] **Step 1: Update the test helper and add a reference test**

In `test/orchestrator.test.ts`, add `library` to the `deps()` helper (after `attempts: {...}`):

```ts
    library: { entries: [], resolveImages: () => [] },
```

Add this test to the `describe("processEmail", ...)` block:

```ts
  it("injects reference images and forces an array-image model", async () => {
    const refBufs = [Buffer.from("r1"), Buffer.from("r2")];
    const d = deps({
      anthropic: anthropicReturning({ task: "generate", modelId: "nano-banana-pro", prompt: "a scene", references: ["andres"] }),
      library: { entries: [], resolveImages: () => refBufs },
    });
    const r = await processEmail(baseEmail(), d);
    expect(r).toBe("generated");
    expect(d.produceImage).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "fal-ai/nano-banana-pro/edit",
        inputImages: refBufs,
        imageInput: "image_urls",
      }),
    );
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/orchestrator.test.ts`
Expected: FAIL — `library` missing on `OrchestratorDeps` / injection not implemented.

- [ ] **Step 3: Implement the orchestrator changes**

In `src/orchestrator.ts`:

Add imports (with the existing ones):

```ts
import { resolveGeneration } from "./reference-routing.js";
import type { ReferenceLibrary } from "./reference-library.js";
```

Add `library` to `OrchestratorDeps`:

```ts
  processed: ProcessedStore;
  attempts: AttemptStore;
  library: ReferenceLibrary;
}
```

Pass the library into the `interpret` call:

```ts
    rawDecision = await interpret(deps.anthropic, {
      text: instruction,
      hasImage: email.imageAttachments.length > 0,
      library: deps.library.entries,
    });
```

Replace the generation `try` block body (current lines ~81–97, from `const model = getModel(...)` through `return "generated";`) with:

```ts
  try {
    const refImages = deps.library.resolveImages(decision.references);
    const resolved = resolveGeneration({
      chosenModelId: decision.modelId,
      userImages: email.imageAttachments,
      refImages,
    });
    const model = resolved.model;
    const image = await deps.produceImage({
      endpoint: model.endpoint,
      prompt: decision.prompt,
      inputImages: resolved.images.length ? resolved.images : undefined,
      imageInput: model.imageInput,
    });
    await deps.sendReply(
      buildReply(email, {
        text: `Done — created with ${model.label}${resolved.overrideNote}.\nPrompt: ${decision.prompt}`,
        image,
        filename: "result.jpg",
      }),
    );
    deps.processed.add(email.id);
    return "generated";
  } catch (err) {
```

(The `catch (err)` block below it is unchanged. The old `getModel` import may now be unused — if `tsc` flags it, remove `getModel` from the `./catalog.js` import line.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/orchestrator.test.ts`
Expected: PASS (all existing + 1 new).

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator.ts test/orchestrator.test.ts
git commit -m "feat(email): inject reference images before generation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Composition roots, assets folder, Docker & docs

**Files:**
- Modify: `src/telegram-index.ts`
- Modify: `src/email-index.ts`
- Create: `assets/library.json`
- Create: `assets/README.md`
- Modify: `Dockerfile`
- Modify: `.env.example`
- Modify: `README.md` (short feature note)

**Interfaces:**
- Consumes: `loadReferenceLibrary` from `./reference-library.js`.

- [ ] **Step 1: Create the starter assets library**

Create `assets/library.json` (empty to start — the feature is inert until populated):

```json
[]
```

Create `assets/README.md`:

```markdown
# Reference asset library

Baked into the Docker image. Add people and La Familia brand assets here, then
reference them by name in a request (e.g. "an image of Andrés wearing the
official shirt in a public square").

## Layout

```
assets/
  library.json          # the manifest (array of entries)
  people/<id>/*.jpg      # ~2 photos per person, varied angles
  brand/<id>/*.jpg       # 1+ images per brand asset
```

## Manifest entry

```json
{
  "id": "andres",                       // unique slug used in requests
  "kind": "person",                     // "person" | "brand"
  "name": "Andrés",                     // display name
  "aliases": ["andres"],                // other names the bot should match
  "description": "Andrés, team member", // short disambiguation line
  "images": ["people/andres/1.jpg", "people/andres/2.jpg"]
}
```

Rules:
- `id`s must be unique. Image paths are relative to this folder and must exist
  (startup fails otherwise).
- Keep the library small; images are committed to the repo and shipped in the image.
- After editing, redeploy for changes to take effect.
```

Confirm images will be committed (not git-ignored):

```bash
git check-ignore assets/README.md || echo "assets not ignored — good"
```

If `.gitignore` excludes `*.jpg`/`*.png` globally, add an exception `!assets/**` (there is currently no such rule; only add if needed).

- [ ] **Step 2: Load the library in both composition roots**

In `src/telegram-index.ts`, add the import and load, then pass into the loop deps:

```ts
import { loadReferenceLibrary } from "./reference-library.js";
```

After `const prefs = loadPrefsStore(...)` / offset setup, add:

```ts
const library = loadReferenceLibrary(process.env.REFERENCE_ASSETS_DIR ?? "assets");
```

Add `library` to the deps object passed to `runTelegramLoop`:

```ts
await runTelegramLoop(
  { telegram, anthropic, produceImage, allowlist: config.allowlist, prefs, library },
  () => false,
  30,
  undefined,
  offsetStore,
);
```

In `src/email-index.ts`, add the import:

```ts
import { loadReferenceLibrary } from "./reference-library.js";
```

Load it (after `const attempts = loadAttemptStore(...)`):

```ts
const library = loadReferenceLibrary(process.env.REFERENCE_ASSETS_DIR ?? "assets");
```

Add `library` to the `deps` object:

```ts
const deps: LoopDeps = {
  config,
  anthropic,
  produceImage,
  sendReply: (reply) => mailbox.send(reply),
  processed,
  attempts,
  mailbox,
  library,
};
```

- [ ] **Step 3: Copy assets into the Docker image**

In `Dockerfile`, in the `runner` stage, add an assets copy before the `mkdir`/`chown` line:

```dockerfile
COPY --from=builder /app/dist ./dist
COPY assets ./assets
# State dir for the file-backed stores (per-user model prefs + poll offset).
```

The builder stage does not need assets (they are runtime data, not compiled).

- [ ] **Step 4: Document the optional env var**

In `.env.example`, under the "Shared" section, add:

```bash
# Optional. Directory holding the reference-asset library (people + brand images).
# Defaults to ./assets (baked into the image). Override only for a mounted volume.
# REFERENCE_ASSETS_DIR=assets
```

- [ ] **Step 5: Add a short feature note to the README**

In `README.md`, add a brief subsection (place it near the bot usage section):

```markdown
### Reference assets (people & brand)

The bot can inject known people and La Familia brand images into a generation.
Add entries under `assets/` (see `assets/README.md`), then name them in a request:

> "create an image of Andrés with the official Familia shirt in a public square"

Named references are auto-injected; requests with 2+ images run on Nano Banana
Pro Edit (or Seedream Edit). No attachment is required to use references.
```

- [ ] **Step 6: Run the full suite + build**

Run: `npx vitest run && npm run build`
Expected: all tests PASS, build clean.

- [ ] **Step 7: Commit**

```bash
git add src/telegram-index.ts src/email-index.ts assets Dockerfile .env.example README.md
git commit -m "feat: load reference library at startup; ship assets in the image

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Verification (after all tasks)

- [ ] `npx vitest run` — full suite green.
- [ ] `npm run build` — clean.
- [ ] Manual smoke (optional, needs live keys): populate `assets/` with one person + the shirt, then send the bot "create an image of <name> with the official Familia shirt in a public square" and confirm a composed image comes back with a Nano Banana Pro Edit caption.

## Notes for the implementer

- The library is intentionally empty (`[]`) at ship time; the feature stays inert until the user drops in photos and manifest entries. All tests use fixtures/fakes, so an empty shipped library does not affect them.
- `resolveImages` skips unknown ids (defensive) — the interpreter is told the valid ids, so this is a safety net, not the normal path.
- Behavior change worth noting: the email path now passes `email.imageAttachments` through `resolveGeneration` for every task (previously attachments were used only on `edit`). A plain generate with no attachments is unaffected (0 images → chosen model kept).
