import sharp from "sharp";

export async function toLowRes(
  input: Buffer,
  opts: { maxEdge?: number; quality?: number } = {},
): Promise<Buffer> {
  const maxEdge = opts.maxEdge ?? 1024;
  const quality = opts.quality ?? 80;
  return sharp(input)
    .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality })
    .toBuffer();
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
