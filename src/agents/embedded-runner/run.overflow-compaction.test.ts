import "./run.overflow-compaction.mocks.shared.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../workspace-run.js", () => ({
  resolveRunWorkspaceDir: vi.fn((params: { workspaceDir: string }) => ({
    workspaceDir: params.workspaceDir,
    usedFallback: false,
    fallbackReason: undefined,
    agentId: "main",
  })),
  redactRunIdentifier: vi.fn((value?: string) => value ?? ""),
}));

vi.mock("../embedded-helpers.js", () => ({
  formatBillingErrorMessage: vi.fn(() => ""),
  classifyFailoverReason: vi.fn(() => null),
  formatAssistantErrorText: vi.fn(() => ""),
  isAuthAssistantError: vi.fn(() => false),
  isBillingAssistantError: vi.fn(() => false),
  isCompactionFailureError: vi.fn(() => false),
  isLikelyContextOverflowError: vi.fn((msg?: string) => {
    const lower = (msg ?? "").toLowerCase();
    return lower.includes("request_too_large") || lower.includes("context window exceeded");
  }),
  isFailoverAssistantError: vi.fn(() => false),
  isFailoverErrorMessage: vi.fn(() => false),
  parseImageSizeError: vi.fn(() => null),
  parseImageDimensionError: vi.fn(() => null),
  isRateLimitAssistantError: vi.fn(() => false),
  isTimeoutErrorMessage: vi.fn(() => false),
  pickFallbackThinkingLevel: vi.fn(() => null),
}));

import { compactEmbeddedPiSessionDirect } from "./compact.js";
import { runEmbeddedPiAgent } from "./run.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import { runEmbeddedAttempt } from "./run/attempt.js";
import { buildEmbeddedRunPayloads } from "./run/payloads.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

const mockedRunEmbeddedAttempt = vi.mocked(runEmbeddedAttempt);
const mockedCompactDirect = vi.mocked(compactEmbeddedPiSessionDirect);
let workspaceDir: string;
beforeEach(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "runner-outcome-test-"));
});
afterEach(async () => {
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

describe("runEmbeddedPiAgent overflow compaction trigger routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes trigger=overflow when retrying compaction after context overflow", async () => {
    const overflowError = new Error("request_too_large: Request size exceeds model context window");

    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "Compacted session",
        firstKeptEntryId: "entry-5",
        tokensBefore: 150000,
      },
    });

    await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir,
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-1",
    });

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedCompactDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "overflow",
        authProfileId: "test-profile",
      }),
    );
  });
});

it.each(["error", "stop"] as const)(
  "distinguishes model %s from a tool warning",
  async (stopReason) => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        lastAssistant: {
          stopReason,
          errorMessage: stopReason === "error" ? "Provider unavailable" : undefined,
        } as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );
    vi.mocked(buildEmbeddedRunPayloads).mockReturnValueOnce([
      { isError: true, text: "A tool failed" },
    ]);
    const result = await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir,
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-outcome",
    });
    expect(Boolean(result.meta.providerFailed)).toBe(stopReason === "error");
    expect(result.payloads?.[0].isError).toBe(true);
  },
);
