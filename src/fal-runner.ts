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
}

export async function runModel(fal: FalLike, args: RunArgs): Promise<string> {
  const input: Record<string, unknown> = { prompt: args.prompt };
  if (args.inputImage) {
    input.image_url = await fal.storage.upload(args.inputImage);
  }
  const res = await fal.subscribe(args.endpoint, { input });
  const url = res.data.images?.[0]?.url;
  if (!url) throw new Error("Fal returned no image in result");
  return url;
}
