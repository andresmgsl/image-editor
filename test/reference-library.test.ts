import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { loadReferenceLibrary } from "../src/reference-library.js";

const FIXTURE = "test/fixtures/reflib";

// The fixture images are real (small) JPEGs with distinct dimensions, so
// order/identity can be asserted via width rather than exact-byte string
// content (the M8 downscale pass runs every image through sharp, so
// fixtures must decode as real images).
async function widthOf(buf: Buffer): Promise<number> {
  const meta = await sharp(buf).metadata();
  return meta.width!;
}

describe("loadReferenceLibrary", () => {
  it("loads and validates the manifest", async () => {
    const lib = await loadReferenceLibrary(FIXTURE);
    expect(lib.entries.map((e) => e.id)).toEqual(["andres", "shirt"]);
    expect(lib.entries[0].kind).toBe("person");
  });

  it("resolves images to buffers in reference order across entries", async () => {
    const lib = await loadReferenceLibrary(FIXTURE);
    const bufs = lib.resolveImages(["andres", "shirt"]);
    expect(bufs).toHaveLength(3);
    const widths = await Promise.all(bufs.map(widthOf));
    // andres/1.jpg (40px), andres/2.jpg (50px), shirt/front.jpg (60px) — in that order.
    expect(widths).toEqual([40, 50, 60]);
  });

  it("drops unknown ids without throwing", async () => {
    const lib = await loadReferenceLibrary(FIXTURE);
    const bufs = lib.resolveImages(["nope", "shirt"]);
    expect(bufs).toHaveLength(1);
    expect(await widthOf(bufs[0])).toBe(60);
  });

  it("returns an empty library when the manifest is absent", async () => {
    const lib = await loadReferenceLibrary("test/fixtures/does-not-exist");
    expect(lib.entries).toEqual([]);
    expect(lib.resolveImages(["andres"])).toEqual([]);
  });

  it("throws when a referenced image file is missing", async () => {
    await expect(loadReferenceLibrary("test/fixtures/reflib-missing-image")).rejects.toThrow(/missing image/i);
  });

  it("throws when two entries share an id", async () => {
    await expect(loadReferenceLibrary("test/fixtures/reflib-dup-id")).rejects.toThrow(/duplicate id/i);
  });

  it("contextualizes a malformed manifest (bad JSON) with the manifest path", async () => {
    await expect(loadReferenceLibrary("test/fixtures/reflib-bad-json")).rejects.toThrow(/failed to read\/parse/);
  });

  it("contextualizes a structurally-invalid manifest (schema error) with the manifest path (M7)", async () => {
    await expect(loadReferenceLibrary("test/fixtures/reflib-bad-schema")).rejects.toThrow(
      /test\/fixtures\/reflib-bad-schema\/library\.json/,
    );
  });

  it("downscales an oversize reference image at load time (M8)", async () => {
    const big = await sharp({
      create: { width: 3000, height: 2500, channels: 3, background: { r: 10, g: 120, b: 200 } },
    })
      .jpeg()
      .toBuffer();
    const originalSize = big.byteLength;
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "reflib-large-"));
    mkdirSync(join(dir, "img"));
    writeFileSync(join(dir, "img", "big.jpg"), big);
    writeFileSync(
      join(dir, "library.json"),
      JSON.stringify([{ id: "big", kind: "brand", name: "Big", aliases: [], description: "", images: ["img/big.jpg"] }]),
    );

    const lib = await loadReferenceLibrary(dir);
    const [buf] = lib.resolveImages(["big"]);
    expect(buf.byteLength).toBeLessThan(originalSize);
    const meta = await sharp(buf).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(2048);
  });

  it("leaves a reference image already within the cap byte-identical (no needless re-encode)", async () => {
    const lib = await loadReferenceLibrary(FIXTURE);
    const [buf] = lib.resolveImages(["andres"]);
    const onDisk = readFileSync("test/fixtures/reflib/people/andres/1.jpg");
    expect(buf.equals(onDisk)).toBe(true);
  });
});
