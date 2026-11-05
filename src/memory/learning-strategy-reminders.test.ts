import { describe, expect, it } from "vitest";
import { StrategyRemindersSchema, type StrategyReminder } from "./learning-strategy-contract.js";
import { StrategyReminderSession } from "./learning-strategy-reminders.js";

const rule: StrategyReminder = {
  id: "verify-switch",
  when: [
    { fact: "service.unavailable", is: true },
    { fact: "device.enabled", is: "unknown" },
  ],
  text: "Check the configured switch before toggling.",
};
describe("conditional strategy reminders", () => {
  it("distinguishes missing observations from false and cites visible evidence", () => {
    const session = new StrategyReminderSession();
    expect(session.take([rule])).toEqual([]);
    session.observe("service.unavailable", true, "customer-1");
    expect(session.take([rule])).toEqual([
      { id: rule.id, text: rule.text, evidence: ["customer-1"] },
    ]);
    session.observe("device.enabled", false, "customer-2");
    expect(session.take([rule])).toEqual([]);
    const knownOff = { ...rule, when: [{ fact: "device.enabled", is: false as const }] };
    expect(session.take([knownOff])[0].evidence).toEqual(["customer-2"]);
  });
  it("deduplicates repeated reports, re-arms after invalidation, and resets between episodes", () => {
    const session = new StrategyReminderSession();
    session.observe("service.unavailable", true, "first");
    expect(session.take([rule])).toHaveLength(1);
    session.observe("service.unavailable", true, "same-value-later");
    expect(session.take([rule])).toEqual([]);
    session.invalidate(["service.unavailable"]);
    expect(session.take([rule])).toEqual([]);
    session.observe("service.unavailable", true, "after-mutation");
    expect(session.take([rule])).toHaveLength(1);
    session.reset();
    expect(session.take([rule])).toEqual([]);
  });
  it("suppresses only a fully satisfied skip condition", () => {
    const session = new StrategyReminderSession();
    const conditional = {
      ...rule,
      unless: [
        { fact: "account.checked", is: true as const },
        { fact: "device.checked", is: true as const },
      ],
    };
    session.observe("service.unavailable", true, "problem");
    session.observe("account.checked", true, "account");
    expect(session.take([conditional])).toHaveLength(1);
    session.observe("device.checked", true, "device");
    expect(session.take([conditional])).toEqual([]);
    session.invalidate(["device.checked"]);
    expect(session.take([conditional])).toHaveLength(1);
  });
  it("rejects executable fields, duplicate ids and unbounded rule sets", () => {
    expect(() => StrategyRemindersSchema.parse([{ ...rule, execute: "anything" }])).toThrow();
    expect(() => StrategyRemindersSchema.parse([rule, rule])).toThrow("Duplicate");
    expect(() => StrategyRemindersSchema.parse([{ ...rule, text: "x".repeat(301) }])).toThrow();
    expect(() =>
      StrategyRemindersSchema.parse(
        Array.from({ length: 5 }, (_, i) => ({ ...rule, id: `rule-${i}` })),
      ),
    ).toThrow();
  });
});
