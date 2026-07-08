import { describe, it, expect, vi } from "vitest";
import { runModel, type FalLike } from "../src/fal-runner.js";

describe("runModel", () => {
  it("generates without uploading when there is no input image", async () => {
    const subscribe = vi.fn().mockResolvedValue({ data: { images: [{ url: "https://x/out.png" }] } });
    const upload = vi.fn();
    const fal: FalLike = { subscribe, storage: { upload } };

    const url = await runModel(fal, { endpoint: "fal-ai/flux/schnell", prompt: "a cat" });

    expect(url).toBe("https://x/out.png");
    expect(upload).not.toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalledWith("fal-ai/flux/schnell", { input: { prompt: "a cat" } });
  });

  it("uploads and passes a single image_url string when imageInput is image_url", async () => {
    const subscribe = vi.fn().mockResolvedValue({ data: { images: [{ url: "https://x/edited.png" }] } });
    const upload = vi.fn().mockResolvedValue("https://x/input.png");
    const fal: FalLike = { subscribe, storage: { upload } };

    const url = await runModel(fal, {
      endpoint: "fal-ai/flux-pro/kontext/max", prompt: "make it night",
      inputImage: Buffer.from("img"), imageInput: "image_url",
    });

    expect(upload).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledWith("fal-ai/flux-pro/kontext/max", {
      input: { prompt: "make it night", image_url: "https://x/input.png" },
    });
    expect(url).toBe("https://x/edited.png");
  });

  it("uploads and passes an image_urls array when imageInput is image_urls", async () => {
    const subscribe = vi.fn().mockResolvedValue({ data: { images: [{ url: "https://x/edited.png" }] } });
    const upload = vi.fn().mockResolvedValue("https://x/input.png");
    const fal: FalLike = { subscribe, storage: { upload } };

    const url = await runModel(fal, {
      endpoint: "fal-ai/nano-banana-pro/edit", prompt: "make it night",
      inputImage: Buffer.from("img"), imageInput: "image_urls",
    });

    expect(upload).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledWith("fal-ai/nano-banana-pro/edit", {
      input: { prompt: "make it night", image_urls: ["https://x/input.png"] },
    });
    expect(url).toBe("https://x/edited.png");
  });

  it("throws when the result has no image", async () => {
    const fal: FalLike = { subscribe: vi.fn().mockResolvedValue({ data: {} }), storage: { upload: vi.fn() } };
    await expect(runModel(fal, { endpoint: "e", prompt: "p" })).rejects.toThrow(/no image/i);
  });
});
