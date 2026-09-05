import { describe, expect, it } from "vitest";
import {
  classifyToolResultOutcome,
  isToolResultError,
  isToolResultPending,
} from "./pi-embedded-subscribe.tools.js";

function jsonResult(payload: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], details: payload };
}

describe("classifyToolResultOutcome", () => {
  it("keeps the legacy details.status contract", () => {
    expect(classifyToolResultOutcome({ details: { status: "error" } })).toBe("error");
    expect(classifyToolResultOutcome({ details: { status: "Timeout" } })).toBe("error");
    expect(classifyToolResultOutcome({ details: { status: "completed" } })).toBe("ok");
  });

  it("treats a body-level ok:false as an error (tool success is not task success)", () => {
    const result = jsonResult({ ok: false, error: "task t-1 not found" });
    expect(classifyToolResultOutcome(result)).toBe("error");
    expect(isToolResultError(result)).toBe(true);
  });

  it("treats a non-empty error field without ok:true as an error", () => {
    expect(classifyToolResultOutcome(jsonResult({ error: "wallet locked" }))).toBe("error");
    expect(classifyToolResultOutcome(jsonResult({ ok: true, error: "" }))).toBe("ok");
    expect(classifyToolResultOutcome(jsonResult({ ok: true, error: null }))).toBe("ok");
  });

  it("ok:true wins over an informational error string", () => {
    expect(classifyToolResultOutcome(jsonResult({ ok: true, error: "retried once" }))).toBe("ok");
  });

  it("classifies an approval-pending placeholder as pending, never success", () => {
    const result = jsonResult({ status: "approval-pending", approvalId: "a1" });
    expect(classifyToolResultOutcome(result)).toBe("pending");
    expect(isToolResultPending(result)).toBe(true);
    expect(isToolResultError(result)).toBe(false);
  });

  it("does not second-guess a structured payload that says nothing about failure", () => {
    expect(classifyToolResultOutcome(jsonResult({ status: "running", sessionId: "s" }))).toBe("ok");
    expect(classifyToolResultOutcome(jsonResult({ results: [] }))).toBe("ok");
    expect(classifyToolResultOutcome({ content: [], details: { count: 0 } })).toBe("ok");
  });

  it("falls back to the rendered JSON text when no details are attached", () => {
    const noDetails = { content: [{ type: "text", text: '{"ok": false, "error": "nope"}' }] };
    expect(classifyToolResultOutcome(noDetails)).toBe("error");
    const plain = { content: [{ type: "text", text: "Error: something" }] };
    expect(classifyToolResultOutcome(plain)).toBe("ok");
  });

  it("is safe on primitives and empty results", () => {
    expect(classifyToolResultOutcome(undefined)).toBe("ok");
    expect(classifyToolResultOutcome("text")).toBe("ok");
    expect(classifyToolResultOutcome({})).toBe("ok");
    expect(classifyToolResultOutcome({ details: [1, 2] })).toBe("ok");
  });
});
