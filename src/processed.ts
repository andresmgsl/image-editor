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
