import { describe, it, expect, vi, afterEach } from "vitest";
import sharp from "sharp";
import { toLowRes, downloadImage, downscaleToMax, MAX_DOWNLOAD_BYTES } from "../src/image.js";

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

  it("flattens transparent regions to white instead of black (M2)", async () => {
    // Build a raw RGBA buffer directly: opaque red on the left half,
    // fully-transparent on the right half.
    const width = 100;
    const height = 100;
    const raw = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        raw[idx] = 200; // r
        raw[idx + 1] = 0; // g
        raw[idx + 2] = 0; // b
        raw[idx + 3] = x < width / 2 ? 255 : 0; // alpha: opaque left, transparent right
      }
    }
    const transparent = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();

    const out = await toLowRes(transparent, { maxEdge: 100 });
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("jpeg");

    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    // Sample a pixel from the formerly-transparent right half.
    const x = Math.floor(info.width * 0.75);
    const y = Math.floor(info.height / 2);
    const idx = (y * info.width + x) * info.channels;
    const [r, g, b] = [data[idx], data[idx + 1], data[idx + 2]];
    expect(r).toBeGreaterThan(240);
    expect(g).toBeGreaterThan(240);
    expect(b).toBeGreaterThan(240);
  });
});

describe("downscaleToMax", () => {
  it("downscales an oversize image to the given long-edge cap", async () => {
    const big = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: { r: 10, g: 120, b: 200 } },
    }).jpeg().toBuffer();

    const out = await downscaleToMax(big, 2048);
    const meta = await sharp(out).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(2048);
    expect(out.byteLength).toBeLessThan(big.byteLength);
  });

  it("leaves an already-small image untouched", async () => {
    const small = await sharp({
      create: { width: 200, height: 150, channels: 3, background: { r: 5, g: 5, b: 5 } },
    }).png().toBuffer();

    const out = await downscaleToMax(small, 2048);
    expect(out).toBe(small); // same buffer instance — no re-encode
  });

  it("preserves alpha as PNG when downscaling a transparent source (does not reintroduce M2)", async () => {
    const bigTransparent = await sharp({
      create: { width: 3000, height: 3000, channels: 4, background: { r: 10, g: 120, b: 200, alpha: 0 } },
    })
      .png()
      .toBuffer();

    const out = await downscaleToMax(bigTransparent, 2048);
    const meta = await sharp(out).metadata();
    expect(meta.hasAlpha).toBe(true);
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(2048);
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
