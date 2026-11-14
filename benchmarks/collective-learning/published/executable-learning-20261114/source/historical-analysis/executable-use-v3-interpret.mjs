import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=fileURLToPath(new URL('../..',import.meta.url));
const out=path.join(repo,'reports/collective-learning/executable-use-20261114-v3');
const read=async name=>JSON.parse(await fs.readFile(path.join(out,name),'utf8'));
const r=await read('comparison-readout.json');
const audit=await read('usage-and-latency-audit.json');
assert.equal(r.completePairs,8);assert(audit.allUsageAgrees);
const [baseline,learned]=r.arms;
const result={
  classification:'Exploratory local executable-reuse result on eight authored paired instances of one DOCX workflow.',
  directRepair:{originalPassed:26,repairedPassed:30,total:30,originalRegressionPanelRetained:12,
    limit:'Direct checks establish behavior on this panel, not statistical lifecycle promotion.'},
  agentSuccess:{baseline:baseline.passes,learned:learned.passes,totalPerArm:8,
    descriptivePercentagePointDifference:(learned.passes-baseline.passes)/8*100,
    limit:'One discordant pair does not establish a general accuracy benefit.'},
  reuse:{wholeSkillReads:learned.wholeSkillReads,successfulHelperCommands:learned.observedHelperInvocations,total:8},
  cost:{baselineTotalUsd:baseline.providerUsd,learnedTotalUsd:learned.providerUsd,
    reductionPerScheduledTask:1-learned.providerUsd/baseline.providerUsd,
    baselinePerVerifiedCompletionUsd:baseline.costPerVerifiedCompletion,
    learnedPerVerifiedCompletionUsd:learned.costPerVerifiedCompletion,
    reductionPerVerifiedCompletion:r.relativeCostReduction,
    lowerCostPairs:r.pairedProviderCostDeltas.filter(p=>p.savingsUsd>0).length,
    allSavedResponseUsageAgrees:audit.allUsageAgrees,
    interpretation:'Usage-derived provider charges, including failed task costs and cached tokens; not invoices. Verification has no provider charge here, but its wall time is recorded.'},
  latency:audit.latency,
  predeclaredTarget:{met:r.finitePanelEfficiencyTargetMet,
    explanation:'The frozen target additionally required both arms to pass all eight tasks. The baseline failed one, so that exact target is not met despite lower cost and more checked successes with the helper. The criterion was not changed after observing results.'},
  learningEconomics:{knownLearningUsd:r.learningUsd,unresolvedLearningHoldUsd:r.priorUnresolvedLearningReserveUsd,
    observedEightCompletionAmortizedKnownUsd:r.amortizedKnownCostPerCompletionAtObservedSample,
    observedEightCompletionAmortizedFullHoldUsd:r.amortizedCostPerCompletionIncludingFullPriorHold,
    projectedBreakEvenKnown:r.breakEvenCompletionsFromKnownCosts,
    projectedBreakEvenFullHold:r.breakEvenCompletionsIncludingFullPriorHold,
    interpretation:'The eight observed helper tasks have not repaid the known learning cost. Break-even is an extrapolation assuming the observed cost per verified completion persists; retained holds are unresolved, not assumed charges.'},
  budget:r.budget,
  whatChanged:'The model completed a retained partial executable repair using independently reproduced return-shape diagnostics. The host did not edit candidate code. Ordinary agents subsequently discovered and used the complete immutable package through the normal skill loader.',
  limits:[...r.claimLimits,
    'No blinded visual-fidelity assessment; checks cover bounded content and placement contracts.',
    'Repeated authored variants share mechanisms and one environment; these are not independent task families.',
    'The helpful intervention contains instructions and executable code together; this study does not isolate their individual effects.',
    'Earlier failures and unresolved costs remain preserved. This is not proof of recursive self-improvement or pooled-evidence benefit.'],
  nextDiscriminatingTest:'Transfer the unchanged package to a separate recipient and environment; preregister new task families and compare package reuse with and without pooled evidence under equal budgets. No new paid test is authorized by this report.'
};
await fs.writeFile(path.join(out,'interpretation.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({cost:result.cost,learningEconomics:result.learningEconomics,budget:r.budget}));
