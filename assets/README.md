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
