import { describe, it, expect } from "vitest";
import { loadReferenceLibrary } from "../src/reference-library.js";

const FIXTURE = "test/fixtures/reflib";

describe("loadReferenceLibrary", () => {
  it("loads and validates the manifest", () => {
    const lib = loadReferenceLibrary(FIXTURE);
    expect(lib.entries.map((e) => e.id)).toEqual(["andres", "shirt"]);
    expect(lib.entries[0].kind).toBe("person");
  });

  it("resolves images to buffers in reference order across entries", () => {
    const lib = loadReferenceLibrary(FIXTURE);
    const bufs = lib.resolveImages(["andres", "shirt"]);
    expect(bufs.map((b) => b.toString())).toEqual(["andres-1", "andres-2", "shirt-front"]);
  });

  it("drops unknown ids without throwing", () => {
    const lib = loadReferenceLibrary(FIXTURE);
    const bufs = lib.resolveImages(["nope", "shirt"]);
    expect(bufs.map((b) => b.toString())).toEqual(["shirt-front"]);
  });

  it("returns an empty library when the manifest is absent", () => {
    const lib = loadReferenceLibrary("test/fixtures/does-not-exist");
    expect(lib.entries).toEqual([]);
    expect(lib.resolveImages(["andres"])).toEqual([]);
  });

  it("throws when a referenced image file is missing", () => {
    expect(() => loadReferenceLibrary("test/fixtures/reflib-missing-image")).toThrow(/missing image/i);
  });

  it("throws when two entries share an id", () => {
    expect(() => loadReferenceLibrary("test/fixtures/reflib-dup-id")).toThrow(/duplicate id/i);
  });

  it("contextualizes a malformed manifest with the manifest path", () => {
    expect(() => loadReferenceLibrary("test/fixtures/reflib-bad-json")).toThrow(/failed to read\/parse/);
  });
});
