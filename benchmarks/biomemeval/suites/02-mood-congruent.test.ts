/**
 * BioMemEval Suite 2: Mood-Congruent Retrieval (20% weight)
 *
 * Tests whether retrieval ranking shifts based on the agent's current
 * emotional/hormonal state — the first bidirectional emotion-memory loop
 * in any agent memory system.
 *
 * Reference: Bower, G.H. (1981). Mood and memory.
 */

import { describe, it, expect } from "vitest";
import { moodCongruentBonus } from "../../../src/memory/mood-congruent-boost.js";
import { ScenarioScorer, SuiteScorer } from "../scoring.js";

const suite = new SuiteScorer("Mood-Congruent Retrieval", "02-mood-congruent", 20, 20);

describe("BioMemEval > Mood-Congruent Retrieval", () => {
  it("Scenario 1: Dopamine boosts positive memories (4 pts)", () => {
    const s = new ScenarioScorer("Dopamine → Positive Memories", 4);

    const state = { dopamine: 0.8, cortisol: 0.1, oxytocin: 0.1, lastDecay: Date.now() };

    const positiveBonus = moodCongruentBonus({
      hormonalState: state,
      emotionalValence: 0.9,
      semanticType: "general",
    });
    const neutralBonus = moodCongruentBonus({
      hormonalState: state,
      emotionalValence: 0,
      semanticType: "general",
    });
    const negativeBonus = moodCongruentBonus({
      hormonalState: state,
      emotionalValence: -0.5,
      semanticType: "general",
    });

    s.score("positive bonus > 0", positiveBonus > 0, 1);
    s.score("positive bonus > neutral bonus", positiveBonus > neutralBonus, 1);
    s.score("positive bonus > negative bonus", positiveBonus > negativeBonus, 1);
    s.score("neutral bonus >= negative bonus", neutralBonus >= negativeBonus, 1);

    const result = s.result();
    suite.addScenario(result);
    expect(result.earnedPoints).toBe(4);
  });

  it("Scenario 2: Cortisol boosts task memories (4 pts)", () => {
    const s = new ScenarioScorer("Cortisol → Task Memories", 4);

    const state = { dopamine: 0.1, cortisol: 0.8, oxytocin: 0.1, lastDecay: Date.now() };

    const taskBonus = moodCongruentBonus({
      hormonalState: state,
      emotionalValence: null,
      semanticType: "task_pattern",
    });
    const goalBonus = moodCongruentBonus({
      hormonalState: state,
      emotionalValence: null,
      semanticType: "goal",
    });
    const relBonus = moodCongruentBonus({
      hormonalState: state,
      emotionalValence: null,
      semanticType: "relationship",
    });
    const genBonus = moodCongruentBonus({
      hormonalState: state,
      emotionalValence: null,
      semanticType: "general",
    });

    s.score("task_pattern gets cortisol boost", taskBonus > 0, 1);
    s.score("goal gets cortisol boost", goalBonus > 0, 1);
    s.score("relationship gets NO cortisol boost", relBonus === 0 || relBonus < taskBonus, 1);
    s.score("general gets NO cortisol boost", genBonus === 0 || genBonus < taskBonus, 1);

    const result = s.result();
    suite.addScenario(result);
    expect(result.earnedPoints).toBe(4);
  });

  it("Scenario 3: Oxytocin boosts relational memories (4 pts)", () => {
    const s = new ScenarioScorer("Oxytocin → Relational Memories", 4);

    const state = { dopamine: 0.1, cortisol: 0.1, oxytocin: 0.8, lastDecay: Date.now() };

    const relBonus = moodCongruentBonus({
      hormonalState: state,
      emotionalValence: null,
      semanticType: "relationship",
    });
    const prefBonus = moodCongruentBonus({
      hormonalState: state,
      emotionalValence: null,
      semanticType: "preference",
    });
    const taskBonus = moodCongruentBonus({
      hormonalState: state,
      emotionalValence: null,
      semanticType: "task_pattern",
    });
    const factBonus = moodCongruentBonus({
      hormonalState: state,
      emotionalValence: null,
      semanticType: "fact",
    });

    s.score("relationship gets oxytocin boost", relBonus > 0, 1);
    s.score("preference gets oxytocin boost", prefBonus > 0, 1);
    s.score("task_pattern gets NO oxytocin boost", taskBonus === 0 || taskBonus < relBonus, 1);
    s.score("fact gets NO oxytocin boost", factBonus === 0 || factBonus < relBonus, 1);

    const result = s.result();
    suite.addScenario(result);
    expect(result.earnedPoints).toBe(4);
  });

  it("Scenario 4: Subthreshold activation returns 0 (4 pts)", () => {
    const s = new ScenarioScorer("Subthreshold Activation", 4);

    const state = { dopamine: 0.2, cortisol: 0.2, oxytocin: 0.2, lastDecay: Date.now() };

    const types = ["general", "task_pattern", "relationship", "preference"];
    let allZero = true;

    for (const type of types) {
      const bonus = moodCongruentBonus({
        hormonalState: state,
        emotionalValence: 0.9,
        semanticType: type,
      });
      if (bonus !== 0) {
        allZero = false;
      }
    }

    s.score("all bonuses are 0 when hormones below threshold", allZero, 4);

    const result = s.result();
    suite.addScenario(result);
    expect(result.earnedPoints).toBe(4);
  });

  it("Scenario 5: Max bonus clamping (4 pts)", () => {
    const s = new ScenarioScorer("Max Bonus Clamping", 4);

    const state = { dopamine: 1.0, cortisol: 1.0, oxytocin: 1.0, lastDecay: Date.now() };

    const types = ["general", "task_pattern", "relationship", "preference", "goal", "episode"];
    let allClamped = true;
    let anyNonZero = false;

    for (const type of types) {
      const bonus = moodCongruentBonus({
        hormonalState: state,
        emotionalValence: 1.0,
        semanticType: type,
      });
      if (bonus > 0.15) {
        allClamped = false;
      }
      if (bonus > 0) {
        anyNonZero = true;
      }
    }

    s.score("no bonus exceeds maxBonus (0.15)", allClamped, 2);
    s.score("at least some bonuses are non-zero with max hormones", anyNonZero, 2);

    const result = s.result();
    suite.addScenario(result);
    expect(result.earnedPoints).toBe(4);
  });
});
