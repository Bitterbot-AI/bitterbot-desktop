import { describe, expect, test } from "vitest";
import { WizardSession } from "./session.js";

function noteRunner() {
  return new WizardSession(async (prompter) => {
    await prompter.note("Welcome");
    const name = await prompter.text({ message: "Name" });
    await prompter.note(`Hello ${name}`);
  });
}

describe("WizardSession", () => {
  test("steps progress in order", async () => {
    const session = noteRunner();

    const first = await session.next();
    expect(first.done).toBe(false);
    expect(first.step?.type).toBe("note");

    const secondPeek = await session.next();
    expect(secondPeek.step?.id).toBe(first.step?.id);

    if (!first.step) {
      throw new Error("expected first step");
    }
    await session.answer(first.step.id, null);

    const second = await session.next();
    expect(second.done).toBe(false);
    expect(second.step?.type).toBe("text");

    if (!second.step) {
      throw new Error("expected second step");
    }
    await session.answer(second.step.id, "Peter");

    const third = await session.next();
    expect(third.step?.type).toBe("note");

    if (!third.step) {
      throw new Error("expected third step");
    }
    await session.answer(third.step.id, null);

    const done = await session.next();
    expect(done.done).toBe(true);
    expect(done.status).toBe("done");
  });

  test("invalid answers throw", async () => {
    const session = noteRunner();
    const first = await session.next();
    await expect(session.answer("bad-id", null)).rejects.toThrow(/wizard: no pending step/i);
    if (!first.step) {
      throw new Error("expected first step");
    }
    await session.answer(first.step.id, null);
  });

  test("cancel marks session and unblocks", async () => {
    const session = new WizardSession(async (prompter) => {
      await prompter.text({ message: "Name" });
    });

    const step = await session.next();
    expect(step.step?.type).toBe("text");

    session.cancel();

    const done = await session.next();
    expect(done.done).toBe(true);
    expect(done.status).toBe("cancelled");
  });
});

describe("WizardSession answers (PLAN-56 Phase 4)", () => {
  test("a select answer must be one of the offered options", async () => {
    let picked: unknown;
    const session = new WizardSession(async (prompter) => {
      picked = await prompter.select({
        message: "Web search",
        options: [
          { value: "later", label: "Later" },
          { value: "env:brave", label: "Brave" },
        ],
      });
    });
    const step = (await session.next()).step!;
    await expect(session.answer(step.id, "env:anything")).rejects.toThrow(
      "not one of the offered options",
    );
    // Refused without consuming the step: a valid answer still goes through.
    expect((await session.next()).step?.id).toBe(step.id);
    await session.answer(step.id, "env:brave");
    expect((await session.next()).done).toBe(true);
    expect(picked).toBe("env:brave");
  });

  test("multiselect answers are checked option by option", async () => {
    const session = new WizardSession(async (prompter) => {
      await prompter.multiselect({
        message: "Pick",
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
      });
    });
    const step = (await session.next()).step!;
    await expect(session.answer(step.id, ["a", "zzz"])).rejects.toThrow();
    await expect(session.answer(step.id, "a")).rejects.toThrow();
    await session.answer(step.id, ["b"]);
    expect((await session.next()).done).toBe(true);
  });

  test("next and answer refresh lastActivityAt", async () => {
    const session = noteRunner();
    session.lastActivityAt = 0;
    await session.next();
    expect(session.lastActivityAt).toBeGreaterThan(0);
  });
});
