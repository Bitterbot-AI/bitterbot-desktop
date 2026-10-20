/**
 * Round 2: the lexical (BM25) index over a conversation's dialogue. It is the
 * product module now (`src/agents/runtime/compaction/transcript-recall.ts`):
 * the `memory_search` stand-in and the automatic-recall arm use the code the
 * runtime ships.
 */
export {
  Bm25,
  type Chunk,
  chunkDialogue,
  renderSnippets,
  tokenize,
} from "../../src/agents/runtime/compaction/transcript-recall.js";
