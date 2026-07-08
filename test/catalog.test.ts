import { describe, it, expect } from "vitest";
import { CATALOG, getModel, modelsForTask, isValidChoice, defaultModelFor } from "../src/catalog.js";

describe("catalog", () => {
  it("has both generate and edit models with unique ids", () => {
    const ids = CATALOG.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(modelsForTask("generate").length).toBeGreaterThan(0);
    expect(modelsForTask("edit").length).toBeGreaterThan(0);
  });

  it("every edit model declares which image field its Fal endpoint requires", () => {
    for (const m of modelsForTask("edit")) {
      expect(m.imageInput, `${m.id} must declare imageInput`).toMatch(/^image_urls?$/);
    }
  });

  it("uses the Fal-verified image field per edit endpoint", () => {
    // Verified live against fal.ai on 2026-07-08 (422 required-field probe).
    expect(getModel("nano-banana-pro-edit")?.imageInput).toBe("image_urls");
    expect(getModel("seedream-edit")?.imageInput).toBe("image_urls");
    expect(getModel("flux-kontext-max")?.imageInput).toBe("image_url");
    expect(getModel("qwen-image-edit")?.imageInput).toBe("image_url");
  });

  it("looks up and validates choices by id + task", () => {
    const gen = modelsForTask("generate")[0];
    expect(getModel(gen.id)?.id).toBe(gen.id);
    expect(isValidChoice(gen.id, "generate")).toBe(true);
    expect(isValidChoice(gen.id, "edit")).toBe(false);
    expect(isValidChoice("does-not-exist", "generate")).toBe(false);
  });

  it("provides a default model per task", () => {
    expect(defaultModelFor("generate").task).toBe("generate");
    expect(defaultModelFor("edit").task).toBe("edit");
  });
});
