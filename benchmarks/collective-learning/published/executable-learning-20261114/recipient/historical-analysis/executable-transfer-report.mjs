import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const repo = '/mnt/d/Bitterbot/bitterbot-desktop';
const root = '/home/vicmg/.local/share/bitterbot-studies/executable-transfer-20261114-v2';
const out = path.join(repo, 'reports/collective-learning', path.basename(root));
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const plan = await read(path.join(out, 'comparison-frozen.json'));
const audit = await read(path.join(out, 'usage-and-latency-audit.json'));
assert(audit.allUsageAgrees);
const helperUse = await read(path.join(out, 'helper-use-audit.json'));
assert(helperUse.allObserved && helperUse.records.length === 12);
const frozen = await read(path.join(out, 'frozen.json'));
const records = [];
for (const job of plan.schedule) records.push(await read(path.join(out, 'agent-records', job.id + '.json')));
assert.equal(records.length, 24);
const fixtures = await read(path.join(repo, 'research/collective-learning/executable-transfer-v2/fixtures/inventory.json'));
const costs = new Map(audit.records.map(r => [r.id, r.ledgerProviderUsd]));
const checked = r => ['pass', 'task-failure'].includes(r.outcome);
const summary = rows => ['frozen', 'learned'].map(arm => {
  const rs = rows.filter(r => r.arm === arm), providerUsd = rs.reduce((n, r) => n + costs.get(r.id), 0);
  const passes = rs.filter(r => r.outcome === 'pass').length;
  return { arm, runs: rs.length, checked: rs.filter(checked).length, passes,
    verifiedTaskFailures: rs.filter(r => r.outcome === 'task-failure').length,
    interruptions: rs.filter(r => r.outcome === 'interrupted').length,
    providerUsd, costPerVerifiedCompletion: passes ? providerUsd / passes : null,
    wholeSkillReads: rs.filter(r => r.reads.includes('SKILL.md')).length,
    observedHelperInvocations: rs.filter(r => r.helperInvocations.length > 0).length,
    tokens: rs.reduce((n, r) => n + r.tokens, 0),
    toolActions: rs.reduce((n, r) => n + r.toolActions.length, 0),
    checkerWallMs: rs.reduce((n, r) => n + r.checkerWallMs, 0),
    latencyMs: rs.reduce((n, r) => n + r.latencyMs, 0) };
});
const pairs = fixtures.filter(f => f.partition === 'evaluation').map(f => {
  const rows = records.filter(r => r.caseId === f.id);
  assert.equal(rows.length, 2);
  const baseline = rows.find(r => r.arm === 'frozen'), learned = rows.find(r => r.arm === 'learned');
  return { caseId: f.id, genre: f.genre, fullyChecked: rows.every(checked),
    frozenOutcome: baseline.outcome, learnedOutcome: learned.outcome,
    frozenUsd: costs.get(baseline.id), learnedUsd: costs.get(learned.id),
    savingsUsd: costs.get(baseline.id) - costs.get(learned.id) };
});
const complete = pairs.filter(p => p.fullyChecked);
const arms = summary(records);
const matchedArms = summary(records.filter(r => complete.some(p => p.caseId === r.caseId)));
const matchedSaving = matchedArms[0].costPerVerifiedCompletion - matchedArms[1].costPerVerifiedCompletion;
const db = new DatabaseSync(path.join(root, 'ledger.sqlite'), { readOnly: true });
const charges = db.prepare('SELECT state,body,cost FROM study_charges').all(); db.close();
assert(charges.every(r => r.state === 'settled'));
const knownUsd = charges.reduce((n, r) => n + JSON.parse(r.cost).providerUsd, 0);
const budget = { knownUsd, heldUsd: 0, unresolved: 0, stageRemainingUsd: 20 - knownUsd,
  cumulativeKnownUsd: frozen.inherited.knownUsd + knownUsd, priorReserveUsd: frozen.inherited.reserveUsd,
  remainingUsd: frozen.inherited.remainingUsd - knownUsd };
assert(Math.abs(knownUsd - arms.reduce((n, a) => n + a.providerUsd, 0)) < 1e-8);
const newFailures = complete.filter(p => p.frozenOutcome === 'pass' && p.learnedOutcome === 'task-failure').length;
const relativeCostReduction = 1 - matchedArms[1].costPerVerifiedCompletion / matchedArms[0].costPerVerifiedCompletion;
const learningUsd = 3.07113425, heldLearningUsd = 14.4;
const result = {
  schemaVersion: 2, createdAt: new Date().toISOString(), comparisonFreeze: plan.hash, repairFreeze: frozen.hash,
  amendment: 'continuation-amendment.json', packageHash: plan.packageHash,
  arms, attemptedPairs: pairs.length, completePairs: complete.length, unstarted: [],
  matchedArms, pairedProviderCostDeltas: pairs, newFailures,
  finitePanelEfficiencyTargetMet: complete.length === 12 && newFailures === 0 &&
    arms[1].wholeSkillReads === 12 && arms[1].observedHelperInvocations === 12 && relativeCostReduction >= 0.5,
  targetAssessment: complete.length === 12 ? 'See finitePanelEfficiencyTargetMet' : 'Original all-12-checked-pairs requirement was not met; descriptive results remain useful.',
  relativeCostReduction,
  allAttemptedCostReduction: 1 - arms[1].providerUsd / arms[0].providerUsd,
  allAttemptedCostPerVerifiedCompletionReduction: 1 - arms[1].costPerVerifiedCompletion / arms[0].costPerVerifiedCompletion,
  allAttemptedAccounting: 'Includes every task cost, including the reconciled interruption. The interruption is not counted as verified success or task failure.',
  matchedAccounting: 'Both members of the interrupted pair are excluded from the fully checked paired estimate. No reruns or replacements.',
  learningUsd, priorUnresolvedLearningReserveUsd: heldLearningUsd, newRepairUsd: 0,
  breakEvenCompletionsFromKnownCosts: matchedSaving > 0 ? Math.ceil(learningUsd / matchedSaving) : null,
  breakEvenCompletionsIncludingFullPriorHold: matchedSaving > 0 ? Math.ceil((learningUsd + heldLearningUsd) / matchedSaving) : null,
  budget, claimLimits: [
    'Development transfer pilot: twelve authored pairs across three genres share one bounded DOCX mechanism, with one interrupted run. No powered efficacy or population noninferiority claim.',
    'Operator-assisted signed offline transfer to separate recipient state and processes on the same physical host and pinned dependency image; lower CPU/memory and explicit timezone/locale.',
    'The helper was generated and repaired in the source study; these recipient runs reuse unchanged bytes. No peer-evidence synthesis was tested.',
    'The competent authored executable control also passes recipient qualification. This comparison tests reuse of the learned executable against repeated model implementation; it does not show that learning beats an equivalent engineered helper.',
    'No automatic Circle/P2P distribution, production promotion, new real user, physical second machine, human visual-fidelity rating or 24-hour retention result yet.',
    'All costs use reported usage and frozen model rates, not invoices. Historical unknown-cost holds remain reserved. Provider caching may cross fresh sessions; arm order alternates.',
    'Wall times include provider, tool and verification latency on a shared host with the normal gateway running, not a dedicated idle benchmark machine.',
  ],
};
const groups = [...new Set(fixtures.filter(f => f.partition === 'evaluation').map(f => f.genre))]
  .map(genre => ({ genre, arms: summary(records.filter(r => fixtures.some(f => f.id === r.caseId && f.genre === genre))) }));
const interruption = await read(path.join(out, 'interruption-audit.json'));
const prior = await read(path.join(repo, 'reports/collective-learning/executable-use-20261114-v3/comparison-readout.json'));
const cumulativeObservedTaskSavings = prior.arms[0].providerUsd - prior.arms[1].providerUsd + arms[0].providerUsd - arms[1].providerUsd;
const interpretation = {
  classification: 'Exploratory recipient transfer of a learned executable; original finite-panel endpoint incomplete because of one host tool-limit interruption.',
  packageHash: plan.packageHash, attemptedPairs: pairs.length, checkedPairs: complete.length, groups, arms,
  matchedArms, matchedCostReduction: relativeCostReduction,
  lowerCostCheckedPairs: complete.filter(p => p.savingsUsd > 0).length,
  finitePanelTargetMet: result.finitePanelEfficiencyTargetMet, targetAssessment: result.targetAssessment,
  latency: audit.latency, allResponseUsageAgrees: true, helperExecutionEvidence: 'helper-use-audit.json',
  interruption: { id: interruption.id, mainOutcome: 'interrupted', supplementaryArtifactGrade: interruption.supplementaryArtifactGrade,
    reconciledProviderUsd: interruption.observedProviderUsd, countedAsVerifiedCompletion: false },
  sourceLearning: { knownUsd: learningUsd, unresolvedHeldUsd: heldLearningUsd,
    projectedBreakEvenKnown: result.breakEvenCompletionsFromKnownCosts,
    projectedBreakEvenFullHold: result.breakEvenCompletionsIncludingFullPriorHold,
    cumulativeObservedTaskSavings, knownSetupRecoveredByObservedGrossSavings: cumulativeObservedTaskSavings >= learningUsd,
    interpretation: 'Conditional savings from paired task charges across the source and recipient pilots. Unresolved setup holds, transfer/verification labor and comparison research spend prevent a complete net-return claim.' },
  budget, retention: { status: 'not-yet-measured', notBefore: new Date(frozen.retentionNotBefore).toISOString(), cases: 6 },
  limitations: result.claimLimits,
  failureCases: records.filter(r => r.outcome === 'task-failure').map(r => ({ id: r.id, grade: r.grade })),
};
for (const directory of [root, out]) await fs.writeFile(path.join(directory, 'comparison-readout.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
await fs.writeFile(path.join(out, 'interpretation.json'), JSON.stringify(interpretation, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ groups, attemptedPairs: pairs.length, checkedPairs: complete.length, matchedCostReduction: relativeCostReduction, finitePanelTargetMet: result.finitePanelEfficiencyTargetMet, budget }));
