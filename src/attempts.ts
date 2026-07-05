import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface AttemptStore {
  /** Increment the failure count for this id and return the new count. */
  record(id: string): number;
  /** Forget this id's failure count. */
  clear(id: string): void;
}

export function loadAttemptStore(filePath: string): AttemptStore {
  const counts = new Map<string, number>();
  if (existsSync(filePath)) {
    try {
      const obj = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, number>;
      for (const [k, v] of Object.entries(obj)) counts.set(k, v);
    } catch {
      // corrupt or empty file: start fresh
    }
  }
  const persist = () => {
    mkdirSync(dirname(filePath), { recursive: true });
    const obj: Record<string, number> = {};
    for (const [k, v] of counts) obj[k] = v;
    writeFileSync(filePath, JSON.stringify(obj));
  };
  return {
    record: (id) => {
      const n = (counts.get(id) ?? 0) + 1;
      counts.set(id, n);
      persist();
      return n;
    },
    clear: (id) => {
      if (counts.delete(id)) persist();
    },
  };
}
