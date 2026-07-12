import { describe, it, expect } from "vitest";
import { loadReferenceLibrary } from "../src/reference-library.js";
import { resolveGeneration } from "../src/reference-routing.js";

// Uses the REAL library loader + REAL routing together (no fakes) to prove the
// resolve -> route seam actually works end to end.
describe("reference library + routing integration", () => {
  it("resolves fixture reference images and routes them into an array-image edit model", () => {
    const lib = loadReferenceLibrary("test/fixtures/reflib");
    const refImages = lib.resolveImages(["andres", "shirt"]);

    const resolved = resolveGeneration({ chosenModelId: "nano-banana-pro", userImages: [], refImages });

    expect(resolved.model.id).toBe("nano-banana-pro-edit");
    expect(resolved.images.length).toBe(3);
    expect(resolved.images.map((b) => b.toString())).toEqual(["andres-1", "andres-2", "shirt-front"]);
  });
});
