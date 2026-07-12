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
- Every image must be a **valid, `sharp`-decodable image** (JPEG/PNG/WebP,
  etc.) — the library is decoded and downscaled to at most 2048 px on the
  long edge at startup (alpha preserved), so a corrupt or undecodable file
  fails startup loudly, not at request time.
- Keep the library small; images are committed to the repo and shipped in the image.
- After editing, redeploy for changes to take effect.

## Photo guidance (people)

- **~2 photos per person**, ideally different angles/lighting — this is
  reference-image conditioning for a subject-consistent model, not face-swap
  training, so variety helps the model recognize the person more than any
  single "perfect" shot.
- **Clear, unobstructed face** in at least one photo (no sunglasses, heavy
  shadow, or the face turned fully away).
- **Decent resolution** — a few hundred pixels on the short edge is plenty;
  images are downscaled to at most 2048 px at load anyway, so there's no
  benefit to shipping anything larger.

## How routing uses references

A request naming a library entry has its images injected automatically —
**no attachment needed**. Whenever the final image count (the user's own
attachment, if any, plus resolved reference images) reaches **2 or more**,
routing forces an array-image edit model — **Nano Banana Pro Edit** by
default (Seedream Edit as the alternative) — regardless of what model would
otherwise have been picked or pinned. See the main
[README](../README.md#reference-assets-people--brand) for the full routing
rules, the 8-image cap, and edge-case behavior (unresolved references).
