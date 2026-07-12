import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface ProcessedStore {
  has(id: string): boolean;
  add(id: string): void;
}

/**
 * Cap on retained ids. Without a cap `ids.json` grows forever and is
 * rewritten O(n) on every single `add` — fine at low volume, but a
 * long-lived mailbox will bloat the file and make every write linear.
 * Insertion order is preserved by `Set`, so capping just drops the oldest.
 */
export const MAX_IDS = 5000;

export function loadProcessedStore(filePath: string, maxIds: number = MAX_IDS): ProcessedStore {
  const set = new Set<string>();
  if (existsSync(filePath)) {
    try {
      const arr = JSON.parse(readFileSync(filePath, "utf8")) as string[];
      for (const s of arr) set.add(s);
    } catch {
      // corrupt or empty file: start fresh
    }
  }
  const persist = () => {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify([...set]));
    renameSync(tmp, filePath); // atomic: a crash mid-write can't truncate the live file
  };
  return {
    has: (id) => set.has(id),
    add: (id) => {
      set.add(id);
      // Drop the oldest entries once we're over the cap (Set iterates in
      // insertion order, so the front of the iterator is the oldest).
      while (set.size > maxIds) {
        const oldest = set.values().next().value;
        if (oldest === undefined) break;
        set.delete(oldest);
      }
      persist();
    },
  };
}
