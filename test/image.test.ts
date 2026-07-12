import { describe, it, expect, vi, afterEach } from "vitest";
import sharp from "sharp";
import { toLowRes, downloadImage, MAX_DOWNLOAD_BYTES } from "../src/image.js";

describe("toLowRes", () => {
  it("downscales a large image to <=1024px long edge and encodes JPEG", async () => {
    const big = await sharp({
      create: { width: 2000, height: 1500, channels: 3, background: { r: 10, g: 120, b: 200 } },
    }).png().toBuffer();

    const out = await toLowRes(big);
    const meta = await sharp(out).metadata();

    expect(meta.format).toBe("jpeg");
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1024);
  });

  it("does not enlarge a small image", async () => {
    const small = await sharp({
      create: { width: 300, height: 300, channels: 3, background: { r: 0, g: 0, b: 0 } },
    }).png().toBuffer();

    const out = await toLowRes(small);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(300);
  });
});

describe("downloadImage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects if the download never completes within the timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
          });
        });
      }),
    );

    await expect(downloadImage("https://x/img.png", { timeoutMs: 20 })).rejects.toThrow();
  });

  it("rejects when content-length exceeds the max download size", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ "content-length": String(MAX_DOWNLOAD_BYTES + 1) }),
        arrayBuffer: vi.fn(),
      }),
    );

    await expect(downloadImage("https://x/img.png")).rejects.toThrow(/exceeds|too large/i);
  });

  it("rejects an oversize body even when content-length is missing or understated", async () => {
    const bigBuf = new ArrayBuffer(MAX_DOWNLOAD_BYTES + 10);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        arrayBuffer: vi.fn().mockResolvedValue(bigBuf),
      }),
    );

    await expect(downloadImage("https://x/img.png")).rejects.toThrow(/exceeds/i);
  });

  it("resolves normally for a small, well-behaved response", async () => {
    const small = new ArrayBuffer(10);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ "content-length": "10" }),
        arrayBuffer: vi.fn().mockResolvedValue(small),
      }),
    );

    const buf = await downloadImage("https://x/img.png");
    expect(buf.byteLength).toBe(10);
  });
});
