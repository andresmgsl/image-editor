import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface OffsetStore {
  get(): number;
  set(offset: number): void;
}

/** In-memory offset — the default when no persistence is wired (e.g. tests). */
export function memoryOffsetStore(initial = 0): OffsetStore {
  let value = initial;
  return { get: () => value, set: (offset) => { value = offset; } };
}

/**
 * File-backed getUpdates offset so a restart or redeploy doesn't re-deliver (and
 * re-bill) updates the previous process already handled. Written atomically.
 */
export function loadOffsetStore(filePath: string): OffsetStore {
  let value = 0;
  if (existsSync(filePath)) {
    try {
      value = Number((JSON.parse(readFileSync(filePath, "utf8")) as { offset?: number }).offset) || 0;
    } catch {
      // corrupt file: start from 0
    }
  }
  return {
    get: () => value,
    set: (offset) => {
      value = offset;
      mkdirSync(dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ offset }));
      renameSync(tmp, filePath);
    },
  };
}
