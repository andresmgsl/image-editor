import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { loadProcessedStore } from "../src/processed.js";

describe("processed store", () => {
  it("records ids and persists them across reloads", () => {
    const path = join(tmpdir(), `proc-${process.pid}.json`);
    rmSync(path, { force: true });

    const store = loadProcessedStore(path);
    expect(store.has("m-7")).toBe(false);
    store.add("m-7");
    expect(store.has("m-7")).toBe(true);

    const reloaded = loadProcessedStore(path);
    expect(reloaded.has("m-7")).toBe(true);

    rmSync(path, { force: true });
  });
});
