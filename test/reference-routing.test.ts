import { describe, it, expect } from "vitest";
import { resolveGeneration, MAX_INJECTED_IMAGES } from "../src/reference-routing.js";
import { defaultModelFor } from "../src/catalog.js";

const buf = (s: string) => Buffer.from(s);

describe("resolveGeneration", () => {
  it("keeps the chosen text model when there are no images", () => {
    const r = resolveGeneration({ chosenModelId: "flux-schnell", userImages: [], refImages: [] });
    expect(r.model.id).toBe("flux-schnell");
    expect(r.images).toEqual([]);
    expect(r.overrideNote).toBe("");
  });

  it("orders user images before reference images", () => {
    const r = resolveGeneration({
      chosenModelId: "seedream-edit",
      userImages: [buf("user")],
      refImages: [buf("ref1"), buf("ref2")],
    });
    expect(r.images.map((b) => b.toString())).toEqual(["user", "ref1", "ref2"]);
  });

  it("overrides a text model to nano-banana-pro-edit when a single reference image is present", () => {
    const r = resolveGeneration({ chosenModelId: "flux-schnell", userImages: [], refImages: [buf("a")] });
    expect(r.model.id).toBe("nano-banana-pro-edit");
    expect(r.overrideNote).not.toBe("");
  });

  it("keeps a single-image edit model when exactly one image is present", () => {
    const r = resolveGeneration({ chosenModelId: "flux-kontext-max", userImages: [buf("a")], refImages: [] });
    expect(r.model.id).toBe("flux-kontext-max");
    expect(r.overrideNote).toBe("");
  });

  it("overrides a single-image edit model to nano-banana-pro-edit when 2+ images are present", () => {
    const r = resolveGeneration({ chosenModelId: "flux-kontext-max", userImages: [buf("a"), buf("b")], refImages: [] });
    expect(r.model.id).toBe("nano-banana-pro-edit");
    expect(r.overrideNote).not.toBe("");
  });

  it("keeps an array-image model when 2+ images are present", () => {
    const r = resolveGeneration({ chosenModelId: "seedream-edit", userImages: [buf("a")], refImages: [buf("b")] });
    expect(r.model.id).toBe("seedream-edit");
    expect(r.overrideNote).toBe("");
  });

  it("trims injected images to the cap and reports the dropped count", () => {
    const many = Array.from({ length: MAX_INJECTED_IMAGES + 3 }, (_, i) => buf(`i${i}`));
    const r = resolveGeneration({ chosenModelId: "seedream-edit", userImages: many, refImages: [] });
    expect(r.images.length).toBe(MAX_INJECTED_IMAGES);
    expect(r.droppedCount).toBe(3);
  });

  it("never keeps an edit model when there are zero images (would 422 with no image)", () => {
    const r = resolveGeneration({ chosenModelId: "nano-banana-pro-edit", userImages: [], refImages: [] });
    expect(r.model.imageInput).toBeUndefined();
    expect(r.model.id).toBe(defaultModelFor("generate").id);
  });

  it("falls back to the default generate model for an unknown model id with zero images", () => {
    const r = resolveGeneration({ chosenModelId: "totally-bogus-id", userImages: [], refImages: [] });
    expect(r.model.id).toBe(defaultModelFor("generate").id);
  });
});
