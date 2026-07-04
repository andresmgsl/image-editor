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

export async function downloadImage(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image download failed: ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}
