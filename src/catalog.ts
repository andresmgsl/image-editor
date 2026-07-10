export type TaskType = "generate" | "edit";

export interface CatalogModel {
  id: string;
  endpoint: string;
  label: string;
  description: string;
  task: TaskType;
  /**
   * Which field the Fal endpoint expects the attached image under. Required for
   * `edit` models (they differ: some want a single `image_url` string, others an
   * `image_urls` array). Verified live against fal.ai per endpoint.
   */
  imageInput?: "image_url" | "image_urls";
}

// All endpoint slugs below verified live on 2026-07-10 by running an actual
// generation/edit through @fal-ai/client and confirming an image URL came back.
// (An empty-body queue POST is NOT a reliable check — the queue accepts unknown
// paths with 200 and only fails at run time, so several bad slugs were caught
// only by a real generation.)
export const CATALOG: CatalogModel[] = [
  // --- generation (text -> image) ---
  { id: "nano-banana-pro", endpoint: "fal-ai/nano-banana-pro", label: "Nano Banana Pro", task: "generate",
    description: "Default quality pick. Complex scenes, best-in-class text and typography rendering." },
  { id: "flux2-pro", endpoint: "fal-ai/flux-2-pro", label: "FLUX.2 [pro]", task: "generate",
    description: "Photorealism and general high-fidelity image generation." },
  { id: "seedream", endpoint: "fal-ai/bytedance/seedream/v4/text-to-image", label: "Seedream V4", task: "generate",
    description: "High-aesthetic, stylized and marketing-oriented imagery." },
  { id: "ideogram-v3", endpoint: "fal-ai/ideogram/v3", label: "Ideogram V3", task: "generate",
    description: "Best when the request centers on text, logos, posters, or typography." },
  { id: "recraft-v3", endpoint: "fal-ai/recraft-v3", label: "Recraft V3", task: "generate",
    description: "Design, brand, and vector-style output: icons, precise styles." },
  { id: "flux-schnell", endpoint: "fal-ai/flux/schnell", label: "FLUX schnell", task: "generate",
    description: "Fast and cheap. Use for simple or quick requests where speed and cost win." },
  // --- editing (input image + instruction) ---
  // imageInput verified live against fal.ai on 2026-07-08 (required-field probe).
  { id: "nano-banana-pro-edit", endpoint: "fal-ai/nano-banana-pro/edit", label: "Nano Banana Pro Edit", task: "edit",
    imageInput: "image_urls",
    description: "Default edit pick. Natural-language edits, text edits, strong subject consistency." },
  { id: "flux-kontext-max", endpoint: "fal-ai/flux-pro/kontext/max", label: "FLUX Pro Kontext Max", task: "edit",
    imageInput: "image_url",
    description: "Targeted local edits and whole-scene transforms." },
  { id: "seedream-edit", endpoint: "fal-ai/bytedance/seedream/v4/edit", label: "Seedream Edit", task: "edit",
    imageInput: "image_urls",
    description: "Multi-image and style-consistent edits." },
  { id: "qwen-image-edit", endpoint: "fal-ai/qwen-image-edit", label: "Qwen Image Edit", task: "edit",
    imageInput: "image_url",
    description: "Multilingual text-in-image edits." },
];

export function getModel(id: string): CatalogModel | undefined {
  return CATALOG.find((m) => m.id === id);
}

export function modelsForTask(task: TaskType): CatalogModel[] {
  return CATALOG.filter((m) => m.task === task);
}

export function isValidChoice(id: string, task: TaskType): boolean {
  return getModel(id)?.task === task;
}

export function defaultModelFor(task: TaskType): CatalogModel {
  const id = task === "edit" ? "nano-banana-pro-edit" : "nano-banana-pro";
  return getModel(id)!;
}
