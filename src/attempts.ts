import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface AttemptStore {
  /** Increment the failure count for this uid and return the new count. */
  record(uid: number): number;
  /** Forget this uid's failure count. */
  clear(uid: number): void;
}

export function loadAttemptStore(filePath: string): AttemptStore {
  const counts = new Map<number, number>();
  if (existsSync(filePath)) {
    try {
      const obj = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, number>;
      for (const [k, v] of Object.entries(obj)) counts.set(Number(k), v);
    } catch {
      // corrupt or empty file: start fresh
    }
  }
  const persist = () => {
    mkdirSync(dirname(filePath), { recursive: true });
    const obj: Record<string, number> = {};
    for (const [k, v] of counts) obj[String(k)] = v;
    writeFileSync(filePath, JSON.stringify(obj));
  };
  return {
    record: (uid) => {
      const n = (counts.get(uid) ?? 0) + 1;
      counts.set(uid, n);
      persist();
      return n;
    },
    clear: (uid) => {
      if (counts.delete(uid)) persist();
    },
  };
}
