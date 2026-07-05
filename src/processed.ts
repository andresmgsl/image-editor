import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface ProcessedStore {
  has(id: string): boolean;
  add(id: string): void;
}

export function loadProcessedStore(filePath: string): ProcessedStore {
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
    writeFileSync(filePath, JSON.stringify([...set]));
  };
  return {
    has: (id) => set.has(id),
    add: (id) => {
      set.add(id);
      persist();
    },
  };
}
