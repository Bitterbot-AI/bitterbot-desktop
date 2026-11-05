/** Descriptive interface coverage, never a learning or task-performance gate. */
export function summarizeCompliance(episodes) {
  const rows = episodes.map(({ label, index, episode }) => {
    const reports = episode.transcript.filter((r) => r.type === "public-observations");
    const previous = new Map();
    let refreshedFacts = 0,
      changedValues = 0;
    for (const report of reports) {
      for (const record of report.snapshot.records) {
        const key = `${report.snapshot.scope}/${record.fact}`;
        const prior = previous.get(key);
        if (prior && record.revision > prior.revision) {
          refreshedFacts++;
          if (record.value !== prior.value) changedValues++;
        }
        previous.set(key, record);
      }
    }
    return {
      label,
      index,
      reason: episode.reason,
      nativePassed: episode.verdict.passed,
      modelCalls: episode.transcript.filter((r) => r.id).length,
      toolCalls: episode.cost.toolCalls,
      providerUsd: episode.cost.providerUsd,
      publicReports: reports.length,
      nonemptyReports: reports.filter((r) => r.snapshot.records.length).length,
      publishedFacts: reports.reduce((sum, r) => sum + r.snapshot.records.length, 0),
      refreshedFacts,
      changedValues,
      reminders: episode.transcript
        .filter((r) => r.type === "reminder")
        .reduce((sum, r) => sum + r.matches.length, 0),
      failures: episode.transcript
        .filter((r) => ["observation-failure", "grounding"].includes(r.type))
        .map((r) => ({ type: r.type, issue: r.issue })),
    };
  });
  const interfacePassed =
    rows.length === 2 &&
    rows.every(
      (r) =>
        ["user-ended", "human-transfer"].includes(r.reason) &&
        r.nonemptyReports > 0 &&
        !r.failures.length,
    );
  const refreshExercised = rows.some((r) => r.refreshedFacts > 0);
  const reminderExercised = rows.some((r) => r.reminders > 0);
  return {
    interfaceGate: interfacePassed ? "passed" : "failed-or-incomplete",
    refreshCoverage: refreshExercised ? "exercised" : "unexercised",
    reminderCoverage: reminderExercised ? "exercised" : "unexercised",
    nextStep: !interfacePassed
      ? "offline-interface-diagnosis"
      : !refreshExercised || !reminderExercised
        ? "coverage-incomplete"
        : "eligible-to-design-controlled-learning-study",
    rows,
    learningBenefitEstablished: false,
    limitation:
      "Two unseeded cases in one arm. Native outcomes, successful routing and valid publication do not establish learning, efficiency or transfer. Exact replay and a narrative review are required separately.",
  };
}
