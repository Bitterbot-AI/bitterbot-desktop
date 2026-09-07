/**
 * PLAN-45 5.1: the three corpora. Frozen = the pinned seed-0 exemplar;
 * fresh = the generator at a run seed; private = the node's grown suite.
 */

import type { CorpusId, ResolvedCorpus } from "./plan.js";
import {
  CANONICAL_GENERATOR_VERSION,
  generateCanonicalCorpus,
  loadCanonicalCorpus,
} from "../../../src/memory/skill-evolution/canonical-corpus.js";
import { loadTaskCorpus } from "../../../src/memory/skill-evolution/task-corpus.js";
import {
  CSB_LICENSE,
  ensureContinualSkillBench,
  loadContinualSkillBench,
} from "../external/continual-skill-bench.js";

export async function resolveCorpora(params: {
  ids: readonly CorpusId[];
  seed: number;
  configDir?: string;
  /** PLAN-45 5.5: a ContinualSkillBench checkout (cloned when absent). */
  externalDir?: string;
  externalDomains?: readonly string[];
}): Promise<ResolvedCorpus[]> {
  const out: ResolvedCorpus[] = [];
  for (const id of params.ids) {
    if (id === "frozen") {
      const c = await loadCanonicalCorpus(0);
      out.push(
        c
          ? { id, version: c.version, tasks: c.tasks, note: null }
          : {
              id,
              version: `canonical-g${CANONICAL_GENERATOR_VERSION}-s0`,
              tasks: [],
              note: "exemplar pin mismatch; frozen corpus refused",
            },
      );
    } else if (id === "fresh") {
      const c = generateCanonicalCorpus(params.seed);
      out.push({ id, version: c.version, tasks: c.tasks, note: null });
    } else if (id === "external") {
      if (!params.externalDir) {
        out.push({ id, version: "external-none", tasks: [], note: "no --external <dir> given" });
        continue;
      }
      ensureContinualSkillBench(params.externalDir);
      const loaded = await loadContinualSkillBench(params.externalDir, {
        ...(params.externalDomains?.length ? { domains: params.externalDomains } : {}),
      });
      const skipped = Object.entries(loaded.skipped)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ");
      out.push({
        id,
        version: `csb-${loaded.domains.map((d) => d.replace(/-100$/, "")).join("+")}-det${loaded.tasks.length}`,
        tasks: loaded.tasks,
        note:
          loaded.tasks.length === 0
            ? "no deterministic ContinualSkillBench task found under the directory"
            : `ContinualSkillBench (${CSB_LICENSE}) deterministic subset: ${loaded.tasks.length} tasks; skipped ${skipped || "none"} (need the benchmark's verifiers or a judge)`,
      });
    } else if (id === "private") {
      const c = await loadTaskCorpus(params.configDir ? { configDir: params.configDir } : {});
      out.push(
        c && c.tasks.length > 0
          ? { id, version: `private-${c.version}`, tasks: c.tasks, note: null }
          : { id, version: "private-none", tasks: [], note: "no private suite on this node" },
      );
    }
  }
  return out;
}
