import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, readFileSync } from "node:fs";
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

  it("caps the store at the configured limit, dropping the oldest ids first", () => {
    const path = join(tmpdir(), `proc-cap-${process.pid}.json`);
    rmSync(path, { force: true });

    const cap = 5;
    const store = loadProcessedStore(path, cap);
    for (let i = 0; i < cap + 3; i++) store.add(`id-${i}`);

    const persisted = JSON.parse(readFileSync(path, "utf8")) as string[];
    expect(persisted.length).toBe(cap);

    // Oldest ids were dropped...
    expect(store.has("id-0")).toBe(false);
    expect(store.has("id-1")).toBe(false);
    expect(store.has("id-2")).toBe(false);
    // ...but the most recently added ids are still retained and dedup still works.
    expect(store.has("id-5")).toBe(true);
    expect(store.has("id-6")).toBe(true);
    expect(store.has("id-7")).toBe(true);

    rmSync(path, { force: true });
  });
});
