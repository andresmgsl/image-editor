import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { toLowRes } from "../src/image.js";

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
