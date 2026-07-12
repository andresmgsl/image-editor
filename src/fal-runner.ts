export interface FalLike {
  subscribe(
    endpoint: string,
    opts: { input: Record<string, unknown>; timeout?: number },
  ): Promise<{ data: { images?: Array<{ url: string }> } }>;
  storage: { upload(data: Buffer): Promise<string> };
}

export interface RunArgs {
  endpoint: string;
  prompt: string;
  inputImages?: Buffer[];
  /** Which field the endpoint expects the image under (defaults to image_url). */
  imageInput?: "image_url" | "image_urls";
  /** Max time (ms) to wait for the fal job before giving up. Defaults to 5 minutes. */
  timeout?: number;
}

// Without a timeout fal.subscribe polls forever (no default), which would hang
// the whole bot on one stuck job. 5 minutes is well past any normal job.
const DEFAULT_FAL_TIMEOUT_MS = 300_000;

export async function runModel(fal: FalLike, args: RunArgs): Promise<string> {
  const input: Record<string, unknown> = { prompt: args.prompt };
  const images = args.inputImages ?? [];
  if (images.length > 0) {
    if (args.imageInput === "image_urls") {
      // Array models accept every attached image.
      input.image_urls = await Promise.all(images.map((img) => fal.storage.upload(img)));
    } else {
      // Single-image models take only the first attachment.
      input.image_url = await fal.storage.upload(images[0]);
    }
  }
  const res = await fal.subscribe(args.endpoint, { input, timeout: args.timeout ?? DEFAULT_FAL_TIMEOUT_MS });
  const url = res.data.images?.[0]?.url;
  if (!url) throw new Error("Fal returned no image in result");
  return url;
}
