import sharp from "sharp";

export async function toLowRes(
  input: Buffer,
  opts: { maxEdge?: number; quality?: number } = {},
): Promise<Buffer> {
  const maxEdge = opts.maxEdge ?? 1024;
  const quality = opts.quality ?? 80;
  return sharp(input)
    .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
    // JPEG has no alpha channel; without an explicit flatten, sharp defaults
    // transparent regions to black. Recraft/ideogram outputs (logos, icons)
    // plausibly carry alpha, so flatten onto white instead.
    .flatten({ background: "#ffffff" })
    .jpeg({ quality })
    .toBuffer();
}

/**
 * Downscale an image buffer so its long edge is at most `maxEdge`, without
 * enlarging smaller images. Used for reference-library images, where fidelity
 * beyond ~2K px buys nothing but costs upload time. Unlike `toLowRes`, this
 * preserves the source format's alpha channel (re-encoding to PNG when the
 * source has alpha) instead of forcing JPEG, so it never reintroduces the
 * black-background flattening problem for reference images with transparency.
 */
export async function downscaleToMax(input: Buffer, maxEdge = 2048): Promise<Buffer> {
  const img = sharp(input);
  const meta = await img.metadata();
  const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
  if (longEdge <= maxEdge) return input; // already small enough; skip re-encoding entirely

  const resized = img.resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true });
  return meta.hasAlpha ? resized.png().toBuffer() : resized.jpeg({ quality: 90 }).toBuffer();
}

// Abort a download that hangs this long (undici's default is ~5 min, which
// would otherwise stall the whole sequential poll loop).
const DOWNLOAD_TIMEOUT_MS = 30_000;
// Hard ceiling on a downloaded image's size, checked against both the
// declared content-length and the actual bytes read.
export const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;

export async function downloadImage(url: string, opts: { timeoutMs?: number } = {}): Promise<Buffer> {
  const timeoutMs = opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Image download failed: ${res.status} ${res.statusText}`);

  const contentLength = Number(res.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Image download exceeds ${MAX_DOWNLOAD_BYTES}-byte limit (content-length: ${contentLength})`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Image download exceeds ${MAX_DOWNLOAD_BYTES}-byte limit (actual: ${buf.byteLength})`);
  }
  return buf;
}
