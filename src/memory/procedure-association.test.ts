import { expect, it } from "vitest";
import { ProcedureAssociation } from "./procedure-association.js";

it("learns opposing context associations from balanced independent outcomes", () => {
  for (const method of ["hebbian", "delta", "context-table", "feature-count"] as const) {
    const model = new ProcedureAssociation(["a", "b"], { method });
    for (let i = 0; i < 240; i++) {
      const context = { service: i % 2 ? "old" : "new" };
      const candidate = i % 4 < 2 ? "a" : "b";
      const reward = Number((context.service === "old") === (candidate === "a")) as 0 | 1;
      model.observe({ id: `receipt-${i}`, context, candidate, reward });
    }
    expect(model.rank({ service: "old" })[0].candidate).toBe("a");
    expect(model.rank({ service: "new" })[0].candidate).toBe("b");
  }
});
it("changes its choice after verified reversals and ignores duplicate receipts", () => {
  const model = new ProcedureAssociation(["a", "b"], { halfLife: 32 });
  const train = (start: number, desired: string) => {
    for (let i = start; i < start + 160; i++) {
      const candidate = i % 2 ? "a" : "b";
      model.observe({
        id: String(i),
        context: { endpoint: "export" },
        candidate,
        reward: candidate === desired ? 1 : 0,
      });
    }
  };
  train(0, "a");
  expect(model.rank({ endpoint: "export" })[0].candidate).toBe("a");
  train(160, "b");
  expect(model.rank({ endpoint: "export" })[0].candidate).toBe("b");
  const before = model.rank({ endpoint: "export" });
  expect(
    model.observe({ id: "0", context: { endpoint: "export" }, candidate: "a", reward: 1 }),
  ).toBe(false);
  expect(model.rank({ endpoint: "export" })).toEqual(before);
  expect(model.observations).toBe(320);
});
it("canonicalizes context order, bounds resources, and rejects invalid observations", () => {
  const model = new ProcedureAssociation(["a", "b"], { maxObservations: 1 });
  expect(() =>
    model.observe({ id: "bad", context: {}, candidate: "unknown", reward: 1 }),
  ).toThrow();
  model.observe({ id: "one", context: { x: "1", y: "2" }, candidate: "a", reward: 1 });
  expect(model.rank({ y: "2", x: "1" })).toEqual(model.rank({ x: "1", y: "2" }));
  expect(() => model.observe({ id: "two", context: {}, candidate: "b", reward: 0 })).toThrow(
    /capacity/,
  );
  expect(() => new ProcedureAssociation(["a", "a"])).toThrow();
  expect(() => new ProcedureAssociation(["a"], { learningRate: NaN })).toThrow();
});
