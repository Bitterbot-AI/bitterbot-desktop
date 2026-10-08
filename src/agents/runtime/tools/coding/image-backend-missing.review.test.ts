/**
 * Adversarial review of the vendored read tool (PLAN-52 Phase 5).
 *
 * pi resizes with Photon (WASM, loads everywhere). The port resizes with
 * `sharp` (native binary per platform). When `sharp` cannot be loaded,
 * `resizeImage` returns null before it looks at the image, so the read tool
 * answers "Image omitted: could not be resized below the inline image size
 * limit" for EVERY image, including one that needs no resizing.
 *
 * The rest of the gateway has a path for hosts without sharp
 * (`src/media/image-ops.ts`: `BITTERBOT_IMAGE_BACKEND=sips`, and Bun on macOS
 * by default). On those hosts pi's read tool returned the image and the sips
 * backend bounded it; after the port the model gets no image at all.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("sharp", () => {
  throw new Error("sharp: no prebuilt binary for this platform");
});

// A valid 1x1 PNG.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

type Block = { type: string; mimeType?: string; text?: string };

let dir = "";

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-no-sharp-review-"));
  await fs.writeFile(path.join(dir, "pixel.png"), PNG_1X1);
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("read tool when sharp cannot be loaded", () => {
  // pi's read tool (Photon, WASM) returned the image here; the port must too.
  it("the port still returns an image that is already within the limits", async () => {
    const { createReadTool } = await import("./read.js");
    const result = await createReadTool(dir).execute("call-1", { path: "pixel.png" });
    const blocks = result.content as Block[];
    expect(blocks.map((block) => block.text ?? block.type)).not.toContain(
      "Read image file [image/png]\n[Image omitted: could not be resized below the inline image size limit.]",
    );
    expect(blocks.some((block) => block.type === "image")).toBe(true);
  });
});
