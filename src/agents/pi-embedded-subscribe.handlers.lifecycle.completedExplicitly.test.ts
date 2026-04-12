import { describe, expect, it, vi } from "vitest";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { handleAgentEnd } from "./pi-embedded-subscribe.handlers.lifecycle.js";

vi.mock("../infra/agent-events.js", () => ({
  emitAgentEvent: vi.fn(),
}));

/**
 * Minimal mock context factory for lifecycle handler tests.
 * Only fields needed for handleAgentEnd path.
 */
function createMockContext(overrides?: {
  toolMetas?: Array<{ toolName?: string; meta?: string }>;
  lastAssistant?: unknown;
}): EmbeddedPiSubscribeContext {
  return {
    params: {
      runId: "test-run",
      sessionKey: "test-session",
      onAgentEvent: vi.fn(),
      onBlockReply: undefined,
    },
    state: {
      toolMetas: overrides?.toolMetas ?? [],
      lastAssistant: overrides?.lastAssistant,
      blockBuffer: "",
      blockState: { thinking: false, final: false, inlineCode: { open: false, backtickCount: 0 } },
      pendingCompactionRetry: 0,
    },
    log: { debug: vi.fn(), warn: vi.fn() },
    blockChunker: null,
    emitBlockChunk: vi.fn(),
    resolveCompactionRetry: vi.fn(),
    maybeResolveCompactionWait: vi.fn(),
  } as unknown as EmbeddedPiSubscribeContext;
}

describe("handleAgentEnd — completedExplicitly", () => {
  it("sets completedExplicitly=true when complete tool was called", () => {
    const ctx = createMockContext({
      toolMetas: [
        { toolName: "read", meta: "README.md" },
        { toolName: "exec", meta: "npm test" },
        { toolName: "complete", meta: undefined },
      ],
    });

    handleAgentEnd(ctx);

    expect(emitAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "test-run",
        stream: "lifecycle",
        data: expect.objectContaining({
          phase: "end",
          completedExplicitly: true,
        }),
      }),
    );

    // Also check the onAgentEvent callback
    expect(ctx.params.onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "lifecycle",
        data: expect.objectContaining({
          phase: "end",
          completedExplicitly: true,
        }),
      }),
    );
  });

  it("sets completedExplicitly=false when complete tool was NOT called", () => {
    const ctx = createMockContext({
      toolMetas: [
        { toolName: "read", meta: "README.md" },
        { toolName: "exec", meta: "npm test" },
      ],
    });

    handleAgentEnd(ctx);

    expect(emitAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          phase: "end",
          completedExplicitly: false,
        }),
      }),
    );
  });

  it("sets completedExplicitly=false when toolMetas is empty", () => {
    const ctx = createMockContext({ toolMetas: [] });

    handleAgentEnd(ctx);

    expect(emitAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          phase: "end",
          completedExplicitly: false,
        }),
      }),
    );
  });

  it("does NOT set completedExplicitly on error lifecycle events", () => {
    (emitAgentEvent as ReturnType<typeof vi.fn>).mockClear();

    // Simulate an error (lastAssistant with stopReason=error)
    const ctx = createMockContext({
      toolMetas: [{ toolName: "complete" }],
      lastAssistant: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "Some error",
        content: [],
      },
    });

    handleAgentEnd(ctx);

    // Error events emit phase: "error" without completedExplicitly
    const call = (emitAgentEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data.phase).toBe("error");
    expect(call.data).not.toHaveProperty("completedExplicitly");
  });
});
