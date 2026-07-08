export interface FalLike {
  subscribe(
    endpoint: string,
    opts: { input: Record<string, unknown> },
  ): Promise<{ data: { images?: Array<{ url: string }> } }>;
  storage: { upload(data: Buffer): Promise<string> };
}

export interface RunArgs {
  endpoint: string;
  prompt: string;
  inputImage?: Buffer;
  /** Which field the endpoint expects the image under (defaults to image_url). */
  imageInput?: "image_url" | "image_urls";
}

export async function runModel(fal: FalLike, args: RunArgs): Promise<string> {
  const input: Record<string, unknown> = { prompt: args.prompt };
  if (args.inputImage) {
    const uploaded = await fal.storage.upload(args.inputImage);
    if (args.imageInput === "image_urls") input.image_urls = [uploaded];
    else input.image_url = uploaded;
  }
  const res = await fal.subscribe(args.endpoint, { input });
  const url = res.data.images?.[0]?.url;
  if (!url) throw new Error("Fal returned no image in result");
  return url;
}
