// A separate, host-authored hypothesis. The original four rules remain frozen.
export const MISSING_DIAGNOSTIC_REMINDERS = [
  {
    id: "missing-allowance-check",
    when: [
      { fact: "service.mmsBlocked", is: true },
      { fact: "device.strongCellularSignal", is: true },
      { fact: "account.dataExhausted", is: "unknown" },
    ],
    text: "MMS still fails despite reported strong cellular signal, and this line's data allowance is unverified. Check the affected line's usage against its plan allowance before repeating device resets or handing off. Unknown allowance is not proof of exhaustion; obtain required consent before changes.",
  },
];

export const DIAGNOSTIC_FACTS = ["service.mmsBlocked", "device.strongCellularSignal"];

/** Bounded public reports only. A signal report does not establish internet access.
 * Device changes invalidate both observations; an old failure cannot establish
 * that the requested service still fails after a repair.
 */
export function observeDiagnosticReports(memory, text, evidence) {
  const failures = [],
    signals = [];
  for (const raw of text.replaceAll("*", "").match(/[^.!?\n]+[.!?]?/g) ?? []) {
    const sentence = raw.trim();
    if (
      sentence.endsWith("?") ||
      /["“”]|\b(?:if|maybe|might|would|should|said|says|friend|instructions|example|previously|yesterday)\b/i.test(
        sentence,
      )
    )
      continue;
    if (
      /\b(?:I|my messaging app|the messaging app) (?:still )?(?:cannot|can't|can’t|am unable to) send (?:an? )?MMS\b/i.test(
        sentence,
      ) ||
      /\bMMS (?:is|are) (?:still )?(?:not working|failing)\b/i.test(sentence)
    )
      failures.push(true);
    if (
      /\b(?:I|my messaging app|the messaging app) can (?:now )?send (?:an? )?MMS\b/i.test(
        sentence,
      ) ||
      /\bMMS (?:is|are) (?:now )?working\b/i.test(sentence)
    )
      failures.push(false);
    for (const clause of sentence.split(/[,;—]/).map((part) => part.trim())) {
      if (
        /^(?:(?:and|but) )?(?:now )?(?:(?:I(?:['’]m| am)|my phone is|the status bar is|it(?:['’]s| is)) (?:now |still )?(?:showing|on)|(?:still|now) showing|the status bar (?:still )?shows) (?:an? )?excellent (?:4G|5G) signal(?: with (?:mobile )?data enabled)?[.!]?$/i.test(
          clause,
        ) ||
        /^(?:now )?(?:I(?:['’]m| am)|it(?:['’]s| is)) (?:now |still )?(?:on|connected to) (?:4G|5G) with an excellent signal(?: and (?:mobile )?data is (?:still )?enabled)?[.!]?$/i.test(
          clause,
        ) ||
        /^(?:now )?(?:I(?:['’]m| am)|it(?:['’]s| is)) (?:now |still )?showing (?:an? )?excellent signal(?: strength)? on (?:4G|5G)[.!]?$/i.test(
          clause,
        ) ||
        /^[-• ]*Signal(?: Strength)?: Excellent \((?:4G|5G)\)[.!]?$/i.test(clause)
      )
        signals.push(true);
      if (
        /^(?:(?:and|but) )?(?:now )?(?:(?:I(?:['’]m| am)|my phone is|it(?:['’]s| is)) (?:now |still )?(?:showing|on)|(?:still|now) showing) (?:an? )?(?:poor|weak) (?:2G|3G|4G|5G) signal[.!]?$/i.test(
          clause,
        ) ||
        /^(?:I have|my phone has) no (?:signal|service)[.!]?$/i.test(clause)
      )
        signals.push(false);
    }
  }
  for (const [fact, reports] of [
    ["service.mmsBlocked", failures],
    ["device.strongCellularSignal", signals],
  ]) {
    if (new Set(reports).size > 1) memory.invalidate([fact]);
    else if (reports.length) memory.observe(fact, reports[0], evidence);
  }
}
