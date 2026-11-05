import { expect, it } from "vitest";
// @ts-expect-error Experimental JS fixtures have no declaration file.
import {
  hypotheses,
  apply,
  reference,
  queryPool,
  judge,
  makeTasks,
  diagnosticControl,
  publicTask,
} from "./world.mjs";

it("qualifies independent oracles for every hypothesis and numeric boundary", () => {
  for (const domain of ["numeric", "sequence"])
    for (const version of [1, 2])
      for (const h of hypotheses(domain, version))
        for (const input of domain === "numeric"
          ? Array.from({ length: 201 }, (_, i) => i - 100)
          : queryPool(domain))
          expect(apply(domain, h, input)).toEqual(reference(domain, h, input));
});
it("rejects distinguishable wrong implementations and keeps hidden truth out of public inputs", () => {
  for (const domain of ["numeric", "sequence"])
    for (const task of makeTasks(domain, 19, "qualification", 24)) {
      expect(publicTask(task)).not.toHaveProperty("secret");
      expect(judge(task, `h${task.secret}`)).toBe(true);
      expect(judge(task, "bogus")).toBe(false);
      expect(hypotheses(domain).some((h: { id: string }) => !judge(task, h.id))).toBe(true);
      expect(diagnosticControl(task).passed).toBe(true);
    }
});
it("reserves different deployed hypotheses for development and held-out tasks", () => {
  const development = makeTasks("numeric", 17011, "development", 6);
  const heldOut = makeTasks("numeric", 17011, "held-out", 6);
  expect(
    heldOut.some((task: { secret: number }) =>
      development.some((other: { secret: number }) => task.secret === other.secret),
    ),
  ).toBe(false);
});
