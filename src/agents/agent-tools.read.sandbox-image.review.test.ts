/**
 * Adversarial review of the vendored read tool (PLAN-52 Phase 5).
 *
 * In sandbox mode the image type comes from `detectMime` (content sniff, then
 * file extension), which returns any `image/*` type, not only the four the
 * model APIs accept. pi's Photon cannot decode SVG, TIFF or AVIF, so pi's read
 * tool answered with the "Image omitted" text. sharp can decode them, so the
 * port returns the original bytes as an image block with a media type no
 * provider accepts; the block is stored in the transcript and every later
 * request of that session carries it.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReadTool as createPiReadTool } from "@mariozechner/pi-coding-agent";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectMime } from "../media/mime.js";
import { createBitterbotReadTool, createSandboxedReadTool } from "./agent-tools.read.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

const PROVIDER_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

type Block = { type: string; mimeType?: string; text?: string };

let root = "";

function localBridge(): SandboxFsBridge {
  const resolve = (filePath: string, cwd?: string) =>
    path.isAbsolute(filePath) ? filePath : path.resolve(cwd ?? root, filePath);
  return {
    readFile: ({ filePath, cwd }: { filePath: string; cwd?: string }) =>
      fs.readFile(resolve(filePath, cwd)),
    stat: async ({ filePath, cwd }: { filePath: string; cwd?: string }) => {
      try {
        const stat = await fs.stat(resolve(filePath, cwd));
        return { type: "file", size: stat.size, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    },
  } as unknown as SandboxFsBridge;
}

/** The same sandbox operations and wrapper, on pi's read tool (the behaviour before the port). */
function piSandboxedReadTool(): AnyAgentTool {
  const bridge = localBridge();
  const base = createPiReadTool(root, {
    operations: {
      readFile: (absolutePath: string) => bridge.readFile({ filePath: absolutePath, cwd: root }),
      access: async (absolutePath: string) => {
        if (!(await bridge.stat({ filePath: absolutePath, cwd: root }))) {
          throw new Error("ENOENT");
        }
      },
      detectImageMimeType: async (absolutePath: string) => {
        const buffer = await bridge.readFile({ filePath: absolutePath, cwd: root });
        const mime = await detectMime({ buffer, filePath: absolutePath });
        return mime && mime.startsWith("image/") ? mime : undefined;
      },
    },
  }) as unknown as AnyAgentTool;
  return createBitterbotReadTool(base);
}

async function read(tool: AnyAgentTool, file: string): Promise<Block[]> {
  const result = await tool.execute("call-1", { path: file }, undefined);
  return result.content as Block[];
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "read-sandbox-image-review-"));
  await fs.writeFile(
    path.join(root, "logo.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="red"/></svg>',
  );
  const pixels = sharp({
    create: { width: 32, height: 24, channels: 3, background: { r: 10, g: 200, b: 30 } },
  });
  await fs.writeFile(path.join(root, "scan.tiff"), await pixels.clone().tiff().toBuffer());
  await fs.writeFile(path.join(root, "photo.avif"), await pixels.clone().avif().toBuffer());
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("sandboxed read tool: image types the model APIs do not accept", () => {
  for (const file of ["logo.svg", "scan.tiff", "photo.avif"]) {
    it(`pi (before the port) returns no image block for ${file}`, async () => {
      const blocks = await read(piSandboxedReadTool(), file);
      expect(blocks.filter((block) => block.type === "image")).toEqual([]);
      expect(blocks[0]?.text).toContain("Image omitted");
    });

    it(`the port must not return ${file} as an image block with an unsupported media type`, async () => {
      const blocks = await read(createSandboxedReadTool({ root, bridge: localBridge() }), file);
      const unsupported = blocks
        .filter((block) => block.type === "image")
        .map((block) => block.mimeType)
        .filter((mimeType) => !PROVIDER_IMAGE_TYPES.has(String(mimeType)));
      expect(unsupported).toEqual([]);
    });
  }
});
