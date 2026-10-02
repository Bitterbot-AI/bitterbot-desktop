/**
 * PLAN-52 Phase 5: image detection for the read tool.
 *
 * Vendored from pi-coding-agent 0.73.1 (MIT, Mario Zechner / pi-mono),
 * `utils/mime.ts`: `detectSupportedImageMimeTypeFromFile`.
 *
 * Differences from the original:
 *
 * 1. pi-coding-agent resolves its own `file-type` ^21. This file resolves the
 *    repo's direct dependency, `file-type` ^22. The call (`fileTypeFromBuffer`)
 *    and the four accepted types are the same.
 *
 * The type comes from the file's magic bytes (first 4100 bytes), never from
 * its extension. Only jpeg, png, gif and webp count as images. Everything
 * else, including an empty file, is read as text.
 */
import { open } from "node:fs/promises";
import { fileTypeFromBuffer } from "file-type";

const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const FILE_TYPE_SNIFF_BYTES = 4100;

export async function detectSupportedImageMimeTypeFromFile(
  filePath: string,
): Promise<string | null> {
  const fileHandle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(FILE_TYPE_SNIFF_BYTES);
    const { bytesRead } = await fileHandle.read(buffer, 0, FILE_TYPE_SNIFF_BYTES, 0);
    if (bytesRead === 0) {
      return null;
    }

    const fileType = await fileTypeFromBuffer(buffer.subarray(0, bytesRead));
    if (!fileType) {
      return null;
    }

    if (!IMAGE_MIME_TYPES.has(fileType.mime)) {
      return null;
    }

    return fileType.mime;
  } finally {
    await fileHandle.close();
  }
}
