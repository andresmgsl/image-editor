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
