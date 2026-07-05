import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { loadAttemptStore } from "../src/attempts.js";

describe("attempt store", () => {
  it("increments, persists across reloads, and clears", () => {
    const path = join(tmpdir(), `attempts-${process.pid}.json`);
    rmSync(path, { force: true });

    const s = loadAttemptStore(path);
    expect(s.record("m-5")).toBe(1);
    expect(s.record("m-5")).toBe(2);

    const reloaded = loadAttemptStore(path);
    expect(reloaded.record("m-5")).toBe(3);

    reloaded.clear("m-5");
    expect(loadAttemptStore(path).record("m-5")).toBe(1);

    rmSync(path, { force: true });
  });
});
