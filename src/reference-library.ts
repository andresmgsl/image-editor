import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { downscaleToMax } from "./image.js";

// Reference-library images are uploaded to fal on every generation that names
// them; fidelity beyond this cap buys nothing but costs upload time, so
// downscale once at load time rather than per-request.
const REFERENCE_MAX_EDGE = 2048;

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

// sharp is async-only, so downscaling reference images at load time requires
// this to be async too. Callers (telegram-index.ts, email-index.ts) already
// use top-level await, so `await loadReferenceLibrary(...)` keeps the same
// fail-fast-at-startup behavior — just a promise the caller now awaits.
export async function loadReferenceLibrary(rootDir: string): Promise<ReferenceLibrary> {
  const manifestPath = join(rootDir, "library.json");
  if (!existsSync(manifestPath)) {
    console.log(`Reference library: no manifest at ${manifestPath}; running with an empty library.`);
    return EMPTY;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    throw new Error(`Reference library: failed to read/parse ${manifestPath}: ${(err as Error).message}`);
  }

  let entries: ReferenceEntry[];
  try {
    entries = ManifestSchema.parse(raw) as ReferenceEntry[];
  } catch (err) {
    throw new Error(`Reference library: invalid manifest schema in ${manifestPath}: ${(err as Error).message}`);
  }

  // Validate ids up front, before touching the filesystem for any image, so a
  // duplicate id fails fast regardless of read/decode order.
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) throw new Error(`Reference library: duplicate id "${entry.id}"`);
    seen.add(entry.id);
  }

  const buffers = new Map<string, Buffer[]>();
  for (const entry of entries) {
    const bufs: Buffer[] = [];
    for (const rel of entry.images) {
      const abs = join(rootDir, rel);
      if (!existsSync(abs)) throw new Error(`Reference library: missing image "${rel}" for id "${entry.id}"`);
      const full = readFileSync(abs);
      bufs.push(await downscaleToMax(full, REFERENCE_MAX_EDGE));
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
