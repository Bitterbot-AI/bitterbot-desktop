/**
 * PLAN-52 Phase 5: image downscaling for the read tool.
 *
 * Vendored from pi-coding-agent 0.73.1 (MIT, Mario Zechner / pi-mono),
 * `utils/image-resize.ts`: `resizeImage`, `formatDimensionNote`, with the
 * limits, the candidate order and the shrink loop unchanged.
 *
 * Differences from the original:
 *
 * 1. Image backend. pi decodes, resizes and encodes with Photon
 *    (`@silvia-odwyer/photon-node`, Rust/WASM), which is not a direct
 *    dependency of this repo. This file uses `sharp`, which is. Consequences:
 *    - An image already within the limits is returned with its original bytes
 *      on both sides, so that path is byte identical.
 *    - A resized image has the same target width and height, the same Lanczos3
 *      filter, the same candidate order (PNG first, then JPEG at quality 80,
 *      85, 70, 55, 40) and the same dimension note, but the encoded bytes
 *      differ because the encoders differ. sharp's PNG keeps the source
 *      channel count where Photon always writes RGBA, so which candidate first
 *      fits under the byte limit can differ for images near that limit.
 *    - Resized pixels are converted to 8-bit sRGB by libvips before encoding.
 *      Photon converts to 8-bit RGBA its own way, so colours of CMYK sources
 *      and of half-transparent pixels differ by a few levels.
 *    - Candidates are encoded one at a time until one fits. pi encodes all six
 *      for a size and then takes the first that fits. Same choice, less work.
 *    - What counts as undecodable is decided by libvips (`failOn: "error"`)
 *      instead of the Rust `image` crate. In both cases an undecodable image
 *      gives `null`, which the read tool reports as "Image omitted".
 *    - sharp refuses inputs above its pixel limit (about 268 megapixels);
 *      those give `null` too.
 * 2. EXIF orientation is applied by sharp's auto-orient, for JPEG and WebP
 *    only as in pi's `exif-orientation.ts` (not ported; it works on Photon
 *    images).
 * 3. pi's `photon.ts` loader (WASM path patching for Bun binaries) is not
 *    ported. If `sharp` cannot be loaded the result is `null`, as when Photon
 *    cannot be loaded in pi.
 */
import type { ImageContent } from "@mariozechner/pi-ai";

export interface ImageResizeOptions {
  maxWidth?: number; // Default: 2000
  maxHeight?: number; // Default: 2000
  maxBytes?: number; // Default: 4.5MB of base64 payload (below Anthropic's 5MB limit)
  jpegQuality?: number; // Default: 80
}

export interface ResizedImage {
  data: string; // base64
  mimeType: string;
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
  wasResized: boolean;
}

// 4.5MB of base64 payload. Provides headroom below Anthropic's 5MB limit.
const DEFAULT_MAX_BYTES = 4.5 * 1024 * 1024;

const DEFAULT_OPTIONS: Required<ImageResizeOptions> = {
  maxWidth: 2000,
  maxHeight: 2000,
  maxBytes: DEFAULT_MAX_BYTES,
  jpegQuality: 80,
};

interface EncodedCandidate {
  data: string;
  encodedSize: number;
  mimeType: string;
}

function encodeCandidate(buffer: Buffer, mimeType: string): EncodedCandidate {
  const data = buffer.toString("base64");
  return {
    data,
    encodedSize: Buffer.byteLength(data, "utf-8"),
    mimeType,
  };
}

// The callable sharp() function. sharp >= 0.35 ships ESM types with a `default`
// export; older releases typed the module itself as the function. Accept both
// (same approach as src/media/image-ops.ts).
type SharpModule = typeof import("sharp");
type SharpFn = SharpModule extends { default: infer Fn } ? Fn : SharpModule;

let sharpPromise: Promise<SharpFn | null> | null = null;

/** Load sharp once. Resolves to null when it cannot be loaded. */
function loadSharp(): Promise<SharpFn | null> {
  sharpPromise ??= (async () => {
    try {
      const mod = (await import("sharp")) as unknown as { default?: SharpFn };
      return mod.default ?? (mod as unknown as SharpFn);
    } catch {
      return null;
    }
  })();
  return sharpPromise;
}

/** Formats for which pi applies the EXIF orientation. */
const EXIF_ORIENTED_FORMATS = new Set(["jpeg", "webp"]);

/**
 * Resize an image to fit within the specified max dimensions and encoded file size.
 * Returns null if the image cannot be decoded or cannot be resized below maxBytes.
 *
 * Strategy for staying under maxBytes:
 * 1. First resize to maxWidth/maxHeight
 * 2. Try PNG, then JPEG with the configured and then decreasing qualities
 * 3. If still too large, progressively reduce dimensions until 1x1
 */
export async function resizeImage(
  img: ImageContent,
  options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const inputBuffer = Buffer.from(img.data, "base64");
  const inputBase64Size = Buffer.byteLength(img.data, "utf-8");

  const sharp = await loadSharp();
  if (!sharp) {
    return null;
  }

  try {
    const open = () => sharp(inputBuffer, { failOn: "error" });

    const meta = await open().metadata();
    const applyOrientation = EXIF_ORIENTED_FORMATS.has(meta.format);
    const originalWidth = applyOrientation ? meta.autoOrient.width : meta.width;
    const originalHeight = applyOrientation ? meta.autoOrient.height : meta.height;
    if (!(originalWidth > 0) || !(originalHeight > 0)) {
      return null;
    }
    const format = img.mimeType?.split("/")[1] ?? "png";

    // Check if already within all limits (dimensions AND encoded size)
    if (
      originalWidth <= opts.maxWidth &&
      originalHeight <= opts.maxHeight &&
      inputBase64Size < opts.maxBytes
    ) {
      // pi decodes every image before this check, so a file with a valid
      // header and broken pixel data is omitted, not passed on. Reading the
      // header is not enough for that: force a full decode.
      await open().stats();
      return {
        data: img.data,
        mimeType: img.mimeType ?? `image/${format}`,
        originalWidth,
        originalHeight,
        width: originalWidth,
        height: originalHeight,
        wasResized: false,
      };
    }

    // Calculate initial dimensions respecting max limits
    let targetWidth = originalWidth;
    let targetHeight = originalHeight;

    if (targetWidth > opts.maxWidth) {
      targetHeight = Math.round((targetHeight * opts.maxWidth) / targetWidth);
      targetWidth = opts.maxWidth;
    }
    if (targetHeight > opts.maxHeight) {
      targetWidth = Math.round((targetWidth * opts.maxHeight) / targetHeight);
      targetHeight = opts.maxHeight;
    }

    const qualitySteps = Array.from(new Set([opts.jpegQuality, 85, 70, 55, 40]));
    let currentWidth = targetWidth;
    let currentHeight = targetHeight;

    while (true) {
      // Decode and resize once per size, then encode the candidates from the raw pixels.
      const source = applyOrientation ? open().rotate() : open();
      const { data: pixels, info } = await source
        .resize(currentWidth, currentHeight, { fit: "fill", kernel: "lanczos3" })
        // Raw pixels carry no colour space: make CMYK and 16-bit sources plain 8-bit sRGB.
        .toColourspace("srgb")
        .raw({ depth: "uchar" })
        .toBuffer({ resolveWithObject: true });
      const resized = () =>
        sharp(pixels, {
          raw: { width: info.width, height: info.height, channels: info.channels },
        });

      const encoders: Array<() => Promise<EncodedCandidate>> = [
        async () => encodeCandidate(await resized().png().toBuffer(), "image/png"),
        ...qualitySteps.map(
          (quality) => async () =>
            encodeCandidate(await resized().jpeg({ quality }).toBuffer(), "image/jpeg"),
        ),
      ];
      for (const encode of encoders) {
        const candidate = await encode();
        if (candidate.encodedSize < opts.maxBytes) {
          return {
            data: candidate.data,
            mimeType: candidate.mimeType,
            originalWidth,
            originalHeight,
            width: currentWidth,
            height: currentHeight,
            wasResized: true,
          };
        }
      }

      if (currentWidth === 1 && currentHeight === 1) {
        break;
      }

      const nextWidth = currentWidth === 1 ? 1 : Math.max(1, Math.floor(currentWidth * 0.75));
      const nextHeight = currentHeight === 1 ? 1 : Math.max(1, Math.floor(currentHeight * 0.75));
      if (nextWidth === currentWidth && nextHeight === currentHeight) {
        break;
      }

      currentWidth = nextWidth;
      currentHeight = nextHeight;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Format a dimension note for resized images.
 * This helps the model understand the coordinate mapping.
 */
export function formatDimensionNote(result: ResizedImage): string | undefined {
  if (!result.wasResized) {
    return undefined;
  }

  const scale = result.originalWidth / result.width;
  return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
}
