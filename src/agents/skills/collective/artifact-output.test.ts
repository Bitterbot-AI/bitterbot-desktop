import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  captureArtifacts,
  runBoundedArtifactCheck,
  validArtifactOutputs,
} from "./artifact-output.js";
import { sha256 } from "./contracts.js";

const roots: string[] = [];
async function scratch() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-output-test-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

it("cancels a stalled checker without turning infrastructure failure into task failure", async () => {
  vi.useFakeTimers();
  let checkerSignal: AbortSignal | undefined;
  const pending = runBoundedArtifactCheck(
    (signal) => {
      checkerSignal = signal;
      return new Promise(() => {});
    },
    1000,
    new AbortController().signal,
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(await pending).toBe("infrastructure");
  expect(checkerSignal?.aborted).toBe(true);
});

it("propagates cancellation and classifies broken checker implementations", async () => {
  const controller = new AbortController();
  let checkerSignal: AbortSignal | undefined;
  const pending = runBoundedArtifactCheck(
    (signal) => {
      checkerSignal = signal;
      return new Promise(() => {});
    },
    10000,
    controller.signal,
  );
  await Promise.resolve();
  controller.abort();
  expect(await pending).toBe("infrastructure");
  expect(checkerSignal?.aborted).toBe(true);
  const never = vi.fn(() => true);
  expect(await runBoundedArtifactCheck(never, 10000, controller.signal)).toBe("infrastructure");
  expect(never).not.toHaveBeenCalled();
  expect(
    await runBoundedArtifactCheck(
      () => {
        throw new Error("bad reference");
      },
      10000,
      new AbortController().signal,
    ),
  ).toBe("checker-invalid");
});

it("captures exact binary bytes independently of subsequent workspace writes", async () => {
  const root = await scratch(),
    bytes = Buffer.from([0, 255, 13, 10, 127]);
  await fs.writeFile(path.join(root, "answer.pdf"), bytes);
  const result = await captureArtifacts(root, [{ name: "answer.pdf", maxBytes: 5 }]);
  await fs.writeFile(path.join(root, "answer.pdf"), "changed");
  expect(result).toEqual([{ name: "answer.pdf", sha256: sha256(bytes), bytes }]);
});

it("refuses path aliases, reserved files, duplicates and excessive declarations", () => {
  for (const name of [
    "../answer.pdf",
    "/answer.pdf",
    "C:\\answer.pdf",
    "a/answer.pdf",
    "answer.PDF",
    "con.pdf",
    "answer.pdf:secret",
    "sources.json",
    "session.jsonl",
    "answer.pdf.",
  ])
    expect(validArtifactOutputs([{ name, maxBytes: 10 }])).toBe(false);
  expect(validArtifactOutputs([])).toBe(false);
  expect(
    validArtifactOutputs([
      { name: "a.pdf", maxBytes: 1 },
      { name: "a.pdf", maxBytes: 1 },
    ]),
  ).toBe(false);
  for (const maxBytes of [0, -1, 1.5, Number.NaN, 4 * 1024 * 1024 + 1])
    expect(validArtifactOutputs([{ name: "a.pdf", maxBytes }])).toBe(false);
  expect(
    validArtifactOutputs(
      Array.from({ length: 5 }, (_, i) => ({ name: `a${i}.pdf`, maxBytes: 4 * 1024 * 1024 })),
    ),
  ).toBe(false);
  expect(
    validArtifactOutputs(
      Array.from({ length: 17 }, (_, i) => ({ name: `a${i}.pdf`, maxBytes: 1 })),
    ),
  ).toBe(false);
});

it("refuses missing, oversized, directory and hard-linked outputs", async () => {
  const root = await scratch();
  const spec = [{ name: "answer.pdf", maxBytes: 8 }];
  await expect(captureArtifacts(root, spec)).rejects.toThrow();
  await fs.writeFile(path.join(root, "answer.pdf"), "123456789");
  await expect(captureArtifacts(root, spec)).rejects.toThrow("oversized");
  await fs.unlink(path.join(root, "answer.pdf"));
  await fs.mkdir(path.join(root, "answer.pdf"));
  await expect(captureArtifacts(root, spec)).rejects.toThrow("Unsafe");
  await fs.rmdir(path.join(root, "answer.pdf"));
  await fs.writeFile(path.join(root, "private.txt"), "secret");
  await fs.link(path.join(root, "private.txt"), path.join(root, "answer.pdf"));
  await expect(captureArtifacts(root, spec)).rejects.toThrow("Unsafe");
});

it.skipIf(process.platform === "win32")(
  "refuses symbolic links to files outside the trial",
  async () => {
    const root = await scratch(),
      outside = await scratch();
    await fs.writeFile(path.join(outside, "secret.txt"), "private");
    await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "answer.pdf"));
    await expect(captureArtifacts(root, [{ name: "answer.pdf", maxBytes: 100 }])).rejects.toThrow(
      "Unsafe",
    );
  },
);
