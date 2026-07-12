# Reference Library — brand assets & people in generation

**Date:** 2026-07-12
**Status:** Design approved, pending implementation plan
**Depends on:** the existing Telegram bot + email orchestrator (`src/interpreter.ts`, `src/orchestrator.ts`, `src/telegram-handler.ts`, `src/fal-runner.ts`, `src/catalog.ts`)

## Goal

Let a user reference known **people** and **La Familia brand assets** by name in a
request, and have the bot auto-inject the right reference images into a
multi-image model so the scene is generated with the correct likeness / branding.

Two examples that must work end-to-end:

- `"an image of Andrés riding a horse"` → inject Andrés's photos → subject-consistent generation.
- `"create an image of Andrés with the official Familia shirt in a public square"`
  → inject Andrés's photos + the shirt photos → one composed image.
- `"put the official Familia shirt on this photo"` + an attached photo
  → inject the attached photo + the shirt photos → edited image.

Quality bar: **memes / fun images for Twitter.** Likeness must be *clearly
recognizable*, not perfect. This is why no model training is used.

## Key decision: reference-image conditioning, not training

Considered training a Flux LoRA per person (stronger likeness) vs. reference-image
conditioning (inject photos into a subject-consistent model, no training).
**Chose reference-image conditioning** because:

- The quality bar is memes, not production likeness.
- It reuses the entire existing pipeline (multi-image edit models already wired).
- Adding a person = drop in ~2 photos + a manifest entry. No training job, no cost,
  no retrain-to-update, works with Nano Banana / Seedream (LoRA would lock us to Flux).

## Unifying concept: one reference-asset library

**People and brand assets are the same kind of thing** — a named entry with
reference images. A person is not special (an earlier draft bound people to a
Telegram ID to resolve "me"; that was cut — everyone, including the operators,
is referenced by name).

## Architecture

### 1. The library (baked into the repo)

```
assets/
  library.json
  people/
    andres/  1.jpg 2.jpg
    juan/    1.jpg 2.jpg
  brand/
    shirt/   front.jpg
    hat/     hat.jpg
    logo/    logo.png
```

`library.json` is an array of entries:

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
    "aliases": ["camiseta oficial", "official shirt", "la familia shirt"],
    "description": "The official La Familia Solana t-shirt",
    "images": ["brand/shirt/front.jpg"]
  }
]
```

Entry schema (all fields required except as noted):
- `id` — unique slug, used in `references[]`.
- `kind` — `"person" | "brand"`. Organizational + feeds the description shown to the model.
- `name` — human display name.
- `aliases` — string[], other ways the entry is named (case-insensitive match by the model).
- `description` — short line the interpreter sees, to disambiguate.
- `images` — string[], ≥1 path relative to `assets/`.

**Storage decision:** committed to the repo, baked into the Docker image.
Version-controlled, no runtime state, redeploy to update. Chosen over a mounted
volume or a `/addasset` bot flow because the library changes rarely and stays small.
Managing it via the bot is a possible later phase, explicitly out of scope here.

### 2. `src/reference-library.ts` (new module)

Responsibilities:
- Load and Zod-validate `assets/library.json` **once at startup**.
- Verify every `images` path exists on disk. **Fail loudly at startup** if the
  manifest is malformed or an image is missing — never at request time.
- Expose:
  - `getEntry(id): ReferenceEntry | undefined`
  - `allEntries(): ReferenceEntry[]`
  - `resolveImages(ids: string[]): { entry, buffers }[]` — read image files to Buffers.
  - a helper to render the library as the interpreter's prompt section.
- Unknown ids requested by the interpreter are dropped with a warning (defensive;
  the model is told the valid ids, so this should not normally happen).

The library path is configurable (default `./assets`) so tests can point at a fixture.

### 3. Interpreter changes (`src/interpreter.ts`)

- The `decide` tool gains one field: **`references: string[]`** — library ids the
  request needs. Optional, defaults to `[]`.
- `DecisionSchema` for `generate` and `edit` gains `references: z.array(z.string()).default([])`.
- The **system prompt** gains a "Reference library" section listing each entry:
  `- <id> (<kind>): <name>. aliases: <aliases>. <description>`.
- Instruction added: when the request names a person or brand item present in the
  library, include its `id` in `references`; write the prompt describing the scene
  naturally ("the person shown", "the shirt") — the backend supplies the images.
- No "me" resolution and no sender identity is injected. Names only.

### 4. Routing & injection (shared helper, used by both transports)

A new shared step turns a `Decision` + optional user-attached images into a
concrete model call. Pseudocode:

```
refImages   = resolveImages(decision.references)   // in reference order
userImages  = attached photo(s), if any
allImages   = [...userImages, ...refImages.flatMap(r => r.buffers)]

if allImages.length > 8: trim to first 8 (cost guard), log what was dropped

model = getModel(decision.modelId)   // interpreter's / pinned choice

if allImages.length >= 2 and model is not an array-image model:
    model = default multi-reference model (nano-banana-pro-edit)   // override, note it
        // Seedream Edit is the alternate; interpreter may choose it directly.

produceImage({ endpoint: model.endpoint, prompt, inputImages: allImages,
               imageInput: model.imageInput })
```

Routing rules:
- **2+ images required** → must be an `image_urls` (array) model: **Nano Banana Pro
  Edit** or **Seedream Edit**, defaulting to Nano Banana Pro Edit. Interpreter chooses
  between them; anything else is overridden to the default with a user-facing note.
- **Exactly 1 image** → single-image models (FLUX Kontext Max, Qwen Edit) remain
  valid; interpreter keeps full range.
- **0 images** (plain generate, no references) → unchanged from today.

Nothing is removed from `src/catalog.ts`; this is a routing *constraint*, not a
hardcoded single model. A person requires images to be uploaded even when the user
attached none — so a request with references but no attachment is still an
array-image model call, not a text-to-image call.

### 5. Wiring into both transports

The reference-resolution + routing helper is shared so logic is not duplicated:
- **`src/telegram-handler.ts`** — after `interpret`, run the helper to gather images
  and pick the final model, then `produceImage`. Pinned-model handling composes with
  the override (a pinned single-image model gets overridden for a 2+-image request,
  with a note in the caption).
- **`src/orchestrator.ts`** (email) — same helper between `interpret` and `produceImage`.

## Data flow (worked example)

`"create an image of Andrés with the official Familia shirt in a public square"`
(Telegram, no attachment):

1. `interpret` → `{ task: "generate", modelId: "nano-banana-pro", prompt: "The
   person shown wearing the La Familia shirt, standing in a public square",
   references: ["andres", "shirt"] }`.
2. Helper: `refImages` = Andrés(2) + shirt(1) = 3 buffers. `userImages` = none.
   `allImages` = 3 → needs array model. `nano-banana-pro` is text-only → override to
   `nano-banana-pro-edit`.
3. `produceImage` uploads 3 images as `image_urls`, calls the edit endpoint.
4. Reply with the composed image; caption notes the model.

## Error handling

- **Startup:** malformed manifest or missing image file → process exits with a clear
  error (same posture as existing config validation).
- **Unknown reference id** from the interpreter → dropped with a `console.warn`;
  generation proceeds with whatever resolved (or falls back to plain generate if none).
- **Reference required but none resolved** (e.g. all ids invalid) → behaves like a
  normal generate with no injected images; no crash.
- **Generation failure** → unchanged; existing per-transport error replies.
- **Image cap exceeded** → trim to 8, `console.log` the drop (no silent truncation).

## Testing

Unit tests (Vitest, mocked collaborators — matches existing suite):
- `reference-library`: valid manifest loads; missing file / bad schema throws at
  startup; `resolveImages` returns buffers in id order; unknown id dropped.
- `interpreter`: given a library, a request naming a person+brand yields the right
  `references[]`; a request naming nothing yields `[]`.
- routing helper: 2+ images forces an array model; single image keeps range;
  pinned incompatible model is overridden with a note; cap trims at 8.
- handler + orchestrator: reference images are gathered and passed to `produceImage`
  with `imageInput: "image_urls"`; user attachment + reference compose in order.

A small `assets/` fixture library (tiny placeholder images) backs the tests.

## Out of scope (possible later phases)

- Managing the library via the bot (`/addasset`, `/addphoto`).
- Model training / LoRA per person.
- Mounted-volume or remote asset storage.
- Per-image ordering hints to the model beyond reference order.
