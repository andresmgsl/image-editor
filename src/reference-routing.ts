import {
  getModel,
  isArrayImageModel,
  defaultMultiReferenceModel,
  type CatalogModel,
} from "./catalog.js";

/** Upper bound on images sent to fal in one call — a cost guard. */
export const MAX_INJECTED_IMAGES = 8;

export interface ResolveGenArgs {
  /** Model id chosen by the interpreter or pinned by the user. */
  chosenModelId: string;
  /** Images the user attached (0+). Placed first. */
  userImages: Buffer[];
  /** Reference-library images already resolved, in reference order. */
  refImages: Buffer[];
}

export interface ResolvedGen {
  model: CatalogModel;
  /** Final ordered image list (may be empty). */
  images: Buffer[];
  /** User-facing note when the model was overridden for image capability; "" otherwise. */
  overrideNote: string;
  /** How many images were dropped by the cap. */
  droppedCount: number;
}

/**
 * Turn a chosen model + gathered images into a concrete, image-capable call.
 * With 2+ images the model must accept an `image_urls` array; otherwise it is
 * overridden to the default multi-reference model. With exactly one image any
 * edit model is fine; a text-only model is overridden. With zero images the
 * chosen model is kept as-is (plain text-to-image).
 */
export function resolveGeneration(args: ResolveGenArgs): ResolvedGen {
  let images = [...args.userImages, ...args.refImages];
  let droppedCount = 0;
  if (images.length > MAX_INJECTED_IMAGES) {
    droppedCount = images.length - MAX_INJECTED_IMAGES;
    // No silent truncation — always report a trimmed image set.
    console.warn(`resolveGeneration: dropped ${droppedCount} image(s) over the ${MAX_INJECTED_IMAGES} cap.`);
    images = images.slice(0, MAX_INJECTED_IMAGES);
  }

  const chosen = getModel(args.chosenModelId);
  const count = images.length;

  const capable =
    !!chosen &&
    (count === 0
      ? true
      : count === 1
        ? !!chosen.imageInput // any edit model
        : isArrayImageModel(chosen)); // 2+ needs an array-image model

  if (capable) {
    return { model: chosen!, images, overrideNote: "", droppedCount };
  }

  const model = defaultMultiReferenceModel();
  const overrideNote = ` (auto-switched to a reference-capable model)`;
  return { model, images, overrideNote, droppedCount };
}
