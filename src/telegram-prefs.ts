import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface PrefsStore {
  get(userId: number): string | undefined;
  set(userId: number, modelId: string | null): void;
}

export function loadPrefsStore(filePath: string): PrefsStore {
  const map = new Map<number, string>();
  if (existsSync(filePath)) {
    try {
      const obj = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, string>;
      for (const [k, v] of Object.entries(obj)) map.set(Number(k), v);
    } catch {
      // corrupt or empty file: start fresh
    }
  }
  const persist = () => {
    mkdirSync(dirname(filePath), { recursive: true });
    const obj: Record<string, string> = {};
    for (const [k, v] of map) obj[String(k)] = v;
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj));
    renameSync(tmp, filePath); // atomic
  };
  return {
    get: (userId) => map.get(userId),
    set: (userId, modelId) => {
      if (modelId === null) map.delete(userId);
      else map.set(userId, modelId);
      persist();
    },
  };
}
