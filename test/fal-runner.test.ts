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
    expect(subscribe).toHaveBeenCalledWith("fal-ai/flux/schnell", { input: { prompt: "a cat" }, timeout: 300_000 });
  });

  it("uploads and passes a single image_url string when imageInput is image_url", async () => {
    const subscribe = vi.fn().mockResolvedValue({ data: { images: [{ url: "https://x/edited.png" }] } });
    const upload = vi.fn().mockResolvedValue("https://x/input.png");
    const fal: FalLike = { subscribe, storage: { upload } };

    const url = await runModel(fal, {
      endpoint: "fal-ai/flux-pro/kontext/max", prompt: "make it night",
      inputImages: [Buffer.from("img")], imageInput: "image_url",
    });

    expect(upload).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledWith("fal-ai/flux-pro/kontext/max", {
      input: { prompt: "make it night", image_url: "https://x/input.png" },
      timeout: 300_000,
    });
    expect(url).toBe("https://x/edited.png");
  });

  it("uploads and passes an image_urls array when imageInput is image_urls", async () => {
    const subscribe = vi.fn().mockResolvedValue({ data: { images: [{ url: "https://x/edited.png" }] } });
    const upload = vi.fn().mockResolvedValue("https://x/input.png");
    const fal: FalLike = { subscribe, storage: { upload } };

    const url = await runModel(fal, {
      endpoint: "fal-ai/nano-banana-pro/edit", prompt: "make it night",
      inputImages: [Buffer.from("img")], imageInput: "image_urls",
    });

    expect(upload).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledWith("fal-ai/nano-banana-pro/edit", {
      input: { prompt: "make it night", image_urls: ["https://x/input.png"] },
      timeout: 300_000,
    });
    expect(url).toBe("https://x/edited.png");
  });

  it("uploads every image and passes them all as image_urls for array models", async () => {
    const subscribe = vi.fn().mockResolvedValue({ data: { images: [{ url: "https://x/edited.png" }] } });
    const upload = vi.fn()
      .mockResolvedValueOnce("https://x/one.png")
      .mockResolvedValueOnce("https://x/two.png");
    const fal: FalLike = { subscribe, storage: { upload } };

    await runModel(fal, {
      endpoint: "fal-ai/bytedance/seedream/v4/edit", prompt: "blend them",
      inputImages: [Buffer.from("one"), Buffer.from("two")], imageInput: "image_urls",
    });

    expect(upload).toHaveBeenCalledTimes(2);
    expect(subscribe).toHaveBeenCalledWith("fal-ai/bytedance/seedream/v4/edit", {
      input: { prompt: "blend them", image_urls: ["https://x/one.png", "https://x/two.png"] },
      timeout: 300_000,
    });
  });

  it("uses only the first image for single-image (image_url) models", async () => {
    const subscribe = vi.fn().mockResolvedValue({ data: { images: [{ url: "https://x/edited.png" }] } });
    const upload = vi.fn().mockResolvedValue("https://x/first.png");
    const fal: FalLike = { subscribe, storage: { upload } };

    await runModel(fal, {
      endpoint: "fal-ai/qwen-image-edit", prompt: "make it night",
      inputImages: [Buffer.from("one"), Buffer.from("two")], imageInput: "image_url",
    });

    expect(upload).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledWith("fal-ai/qwen-image-edit", {
      input: { prompt: "make it night", image_url: "https://x/first.png" },
      timeout: 300_000,
    });
  });

  it("throws when the result has no image", async () => {
    const fal: FalLike = { subscribe: vi.fn().mockResolvedValue({ data: {} }), storage: { upload: vi.fn() } };
    await expect(runModel(fal, { endpoint: "e", prompt: "p" })).rejects.toThrow(/no image/i);
  });

  it("defaults the subscribe timeout to 300_000ms so one stuck job can't hang the bot forever", async () => {
    const subscribe = vi.fn().mockResolvedValue({ data: { images: [{ url: "https://x/out.png" }] } });
    const fal: FalLike = { subscribe, storage: { upload: vi.fn() } };

    await runModel(fal, { endpoint: "fal-ai/flux/schnell", prompt: "a cat" });

    expect(subscribe.mock.calls[0][1]).toMatchObject({ timeout: 300_000 });
  });

  it("honors an explicitly injected timeout instead of the default", async () => {
    const subscribe = vi.fn().mockResolvedValue({ data: { images: [{ url: "https://x/out.png" }] } });
    const fal: FalLike = { subscribe, storage: { upload: vi.fn() } };

    await runModel(fal, { endpoint: "fal-ai/flux/schnell", prompt: "a cat", timeout: 5_000 });

    expect(subscribe.mock.calls[0][1]).toMatchObject({ timeout: 5_000 });
  });

  it("rejects within the timeout when fal.storage.upload never resolves (single image_url branch)", async () => {
    const subscribe = vi.fn();
    const upload = vi.fn().mockReturnValue(new Promise<string>(() => {})); // never settles
    const fal: FalLike = { subscribe, storage: { upload } };

    await expect(
      runModel(fal, {
        endpoint: "fal-ai/qwen-image-edit",
        prompt: "make it night",
        inputImages: [Buffer.from("one")],
        imageInput: "image_url",
        uploadTimeout: 10,
      }),
    ).rejects.toThrow(/fal\.storage\.upload timed out after 10ms/);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("rejects within the timeout when fal.storage.upload never resolves (image_urls array branch)", async () => {
    const subscribe = vi.fn();
    const upload = vi.fn().mockReturnValue(new Promise<string>(() => {})); // never settles
    const fal: FalLike = { subscribe, storage: { upload } };

    await expect(
      runModel(fal, {
        endpoint: "fal-ai/bytedance/seedream/v4/edit",
        prompt: "blend them",
        inputImages: [Buffer.from("one"), Buffer.from("two")],
        imageInput: "image_urls",
        uploadTimeout: 10,
      }),
    ).rejects.toThrow(/fal\.storage\.upload timed out after 10ms/);
    expect(subscribe).not.toHaveBeenCalled();
  });
});
