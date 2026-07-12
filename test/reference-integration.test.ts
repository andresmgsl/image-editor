import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { loadReferenceLibrary } from "../src/reference-library.js";
import { resolveGeneration } from "../src/reference-routing.js";

// Uses the REAL library loader + REAL routing together (no fakes) to prove the
// resolve -> route seam actually works end to end.
describe("reference library + routing integration", () => {
  it("resolves fixture reference images and routes them into an array-image edit model", async () => {
    const lib = await loadReferenceLibrary("test/fixtures/reflib");
    const refImages = lib.resolveImages(["andres", "shirt"]);

    const resolved = resolveGeneration({ chosenModelId: "nano-banana-pro", userImages: [], refImages });

    expect(resolved.model.id).toBe("nano-banana-pro-edit");
    expect(resolved.images.length).toBe(3);
    // Fixture images are real (small) JPEGs with distinct widths; order across
    // entries (andres/1, andres/2, shirt/front) is asserted via width rather
    // than exact-byte string content, since the M8 downscale pass decodes
    // every image through sharp.
    const widths = await Promise.all(resolved.images.map(async (b) => (await sharp(b).metadata()).width));
    expect(widths).toEqual([40, 50, 60]);
  });
});
