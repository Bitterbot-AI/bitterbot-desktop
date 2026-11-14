import { describe, expect, it } from "vitest";
import {
  assertExactJsonIntegers,
  compareVaried,
  variedProtocol,
  type VariedCase,
} from "./varied.js";

const task: VariedCase = {
  id: "one",
  family: "parser",
  mode: 0,
  replica: 0,
  partition: "headroom",
  input: { contract: "public" },
  tests: [
    { input: 1, expected: { n: 1 } },
    { input: 2, expected: [] },
    { input: 3, expected: null },
  ],
};
describe("varied task trust boundary", () => {
  it("rejects numeric inputs whose integers lose precision at the JSON bridge", () => {
    expect(() => assertExactJsonIntegers({ weight: 1e18 })).toThrow("round-trip");
    expect(() =>
      assertExactJsonIntegers({ weight: "999999999999999999", quantity: 7 }),
    ).not.toThrow();
  });
  it("compares exact complete JSON results, never candidate verdicts", () => {
    expect(compareVaried(task, [{ n: 1 }, [], null]).status).toBe("pass");
    for (const actual of [{ status: "pass" }, [], [{ n: 1 }, [], null, 0], [{ n: true }, [], null]])
      expect(compareVaried(task, actual).status).toBe("task-failure");
  });
  it("binds hidden answers and public inputs without exposing auxiliary checker files", async () => {
    const protocol = await variedProtocol([task], "pinned-image");
    expect(protocol.inputFiles).toBeUndefined();
    expect(protocol.acceptsInput({ contract: "changed" })).toBe(false);
    await expect(
      protocol.checkDeliverables(
        { id: "wrong", family: "parser", regression: false, input: task.input },
        { status: "pass" },
        "ok",
      ),
    ).rejects.toThrow("Unfrozen");
    const other = await variedProtocol(
      [{ ...task, tests: task.tests.map((t) => ({ ...t, expected: "tampered" })) }],
      "pinned-image",
    );
    expect(other.checkerHash).not.toBe(protocol.checkerHash);
    await expect(variedProtocol([task, task], "pinned-image")).rejects.toThrow("Duplicate");
  });
});
