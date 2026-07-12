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
  /** Max time (ms) to wait for a single fal.storage.upload call before giving up. Defaults to 60s. */
  uploadTimeout?: number;
}

// Without a timeout fal.subscribe polls forever (no default), which would hang
// the whole bot on one stuck job. 5 minutes is well past any normal job.
const DEFAULT_FAL_TIMEOUT_MS = 300_000;

// fal.storage.upload has no built-in timeout either (undici's own default is
// ~5 minutes), and the bot processes requests sequentially, so a stalled
// upload would head-of-line-block every later request. Bound it too. Uploads
// can be several images, so give this a bit more room than a single request.
const DEFAULT_UPLOAD_TIMEOUT_MS = 60_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

export async function runModel(fal: FalLike, args: RunArgs): Promise<string> {
  const input: Record<string, unknown> = { prompt: args.prompt };
  const images = args.inputImages ?? [];
  const uploadTimeoutMs = args.uploadTimeout ?? DEFAULT_UPLOAD_TIMEOUT_MS;
  if (images.length > 0) {
    if (args.imageInput === "image_urls") {
      // Array models accept every attached image.
      input.image_urls = await Promise.all(
        images.map((img) => withTimeout(fal.storage.upload(img), uploadTimeoutMs, "fal.storage.upload")),
      );
    } else {
      // Single-image models take only the first attachment.
      input.image_url = await withTimeout(
        fal.storage.upload(images[0]),
        uploadTimeoutMs,
        "fal.storage.upload",
      );
    }
  }
  const res = await fal.subscribe(args.endpoint, { input, timeout: args.timeout ?? DEFAULT_FAL_TIMEOUT_MS });
  const url = res.data.images?.[0]?.url;
  if (!url) throw new Error("Fal returned no image in result");
  return url;
}
