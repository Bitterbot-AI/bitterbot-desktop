/**
 * PLAN-52 Phase 5: line diff used to build the edit tool's `details.diff`.
 *
 * pi-coding-agent 0.73.1 computes that diff with `Diff.diffLines` from the
 * `diff` package (jsdiff 8.0.3). `diff` is not a direct dependency of this
 * repo, and a different diff algorithm picks different (equally minimal) hunks,
 * so the part pi uses is ported here: the Myers edit-graph walk from
 * `libesm/diff/base.js` and the line tokenizer from `libesm/diff/line.js`.
 *
 * Ported from jsdiff 8.0.3 (BSD-3-Clause). Its notice is kept below as the
 * license requires.
 *
 * Differences from the original:
 *
 * 1. Only `diffLines(oldStr, newStr)` with no options. Left out: the callback
 *    (async) mode, `maxEditLength`, `timeout`, `oneChangePerToken`,
 *    `ignoreCase`, `comparator`, `ignoreWhitespace`, `ignoreNewlineAtEof`,
 *    `newlineIsToken`, `stripTrailingCr`, `useLongestToken`, `postProcess`, and
 *    every other diff flavour (chars, words, sentences, css, json, arrays,
 *    patches).
 * 2. Lines are compared with `===`, which is what jsdiff does with no options.
 * 3. jsdiff keeps its best paths in an array indexed by diagonal, including
 *    negative indices. A `Map` keyed by diagonal is used here.
 * 4. Returned change objects are fresh `{ count, added, removed, value }`
 *    objects. jsdiff reuses its internal linked-list nodes.
 *
 * BSD 3-Clause License
 *
 * Copyright (c) 2009-2015, Kevin Decker <kpdecker@gmail.com>
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its
 *    contributors may be used to endorse or promote products derived from
 *    this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

/** One run of unchanged, added or removed lines. */
export interface LineChange {
  /** Number of lines in this run. */
  count: number;
  /** True when the lines exist only in the new text. */
  added: boolean;
  /** True when the lines exist only in the old text. */
  removed: boolean;
  /** The lines of the run, each with its line ending. */
  value: string;
}

interface DiffComponent {
  count: number;
  added: boolean;
  removed: boolean;
  previousComponent: DiffComponent | undefined;
}

interface DiffPath {
  oldPos: number;
  lastComponent: DiffComponent | undefined;
}

/**
 * Split text into line tokens. Each token keeps its line ending (`\n` or
 * `\r\n`); a final line without one is a token of its own.
 */
function tokenizeLines(value: string): string[] {
  const retLines: string[] = [];
  const linesAndNewlines = value.split(/(\n|\r\n)/);

  // Ignore the final empty token that occurs if the string ends with a new line
  if (!linesAndNewlines[linesAndNewlines.length - 1]) {
    linesAndNewlines.pop();
  }

  // Merge the content and line separators into single tokens
  for (let i = 0; i < linesAndNewlines.length; i++) {
    const line = linesAndNewlines[i];
    if (i % 2) {
      retLines[retLines.length - 1] += line;
    } else {
      retLines.push(line);
    }
  }

  return retLines;
}

function removeEmpty(tokens: string[]): string[] {
  const ret: string[] = [];
  for (const token of tokens) {
    if (token) {
      ret.push(token);
    }
  }
  return ret;
}

function addToPath(path: DiffPath, added: boolean, removed: boolean, oldPosInc: number): DiffPath {
  const last = path.lastComponent;
  if (last && last.added === added && last.removed === removed) {
    return {
      oldPos: path.oldPos + oldPosInc,
      lastComponent: {
        count: last.count + 1,
        added,
        removed,
        previousComponent: last.previousComponent,
      },
    };
  }
  return {
    oldPos: path.oldPos + oldPosInc,
    lastComponent: { count: 1, added, removed, previousComponent: last },
  };
}

/** Follow the diagonal while tokens are equal. Returns the new position in `newTokens`. */
function extractCommon(
  basePath: DiffPath,
  newTokens: string[],
  oldTokens: string[],
  diagonalPath: number,
): number {
  const newLen = newTokens.length;
  const oldLen = oldTokens.length;
  let oldPos = basePath.oldPos;
  let newPos = oldPos - diagonalPath;
  let commonCount = 0;

  while (
    newPos + 1 < newLen &&
    oldPos + 1 < oldLen &&
    oldTokens[oldPos + 1] === newTokens[newPos + 1]
  ) {
    newPos++;
    oldPos++;
    commonCount++;
  }

  if (commonCount) {
    basePath.lastComponent = {
      count: commonCount,
      previousComponent: basePath.lastComponent,
      added: false,
      removed: false,
    };
  }

  basePath.oldPos = oldPos;
  return newPos;
}

function buildValues(
  lastComponent: DiffComponent | undefined,
  newTokens: string[],
  oldTokens: string[],
): LineChange[] {
  // The components are a linked list in reverse order.
  const components: DiffComponent[] = [];
  let current = lastComponent;
  while (current) {
    components.push(current);
    current = current.previousComponent;
  }
  components.reverse();

  const changes: LineChange[] = [];
  let newPos = 0;
  let oldPos = 0;
  for (const component of components) {
    let value: string;
    if (!component.removed) {
      value = newTokens.slice(newPos, newPos + component.count).join("");
      newPos += component.count;
      // Common case
      if (!component.added) {
        oldPos += component.count;
      }
    } else {
      value = oldTokens.slice(oldPos, oldPos + component.count).join("");
      oldPos += component.count;
    }
    changes.push({
      count: component.count,
      added: component.added,
      removed: component.removed,
      value,
    });
  }
  return changes;
}

/**
 * Line diff of two texts, same result as jsdiff 8.0.3 `diffLines(oldStr, newStr)`.
 */
export function diffLines(oldStr: string, newStr: string): LineChange[] {
  const oldTokens = removeEmpty(tokenizeLines(oldStr));
  const newTokens = removeEmpty(tokenizeLines(newStr));

  const newLen = newTokens.length;
  const oldLen = oldTokens.length;
  let editLength = 1;
  const maxEditLength = newLen + oldLen;

  const bestPath = new Map<number, DiffPath | undefined>();
  const seed: DiffPath = { oldPos: -1, lastComponent: undefined };
  bestPath.set(0, seed);

  // Seed editLength = 0, i.e. the content starts with the same values
  let newPos = extractCommon(seed, newTokens, oldTokens, 0);
  if (seed.oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
    // Identity per the equality and tokenizer
    return buildValues(seed.lastComponent, newTokens, oldTokens);
  }

  // Once we hit the right edge of the edit graph on some diagonal k, we can
  // definitely reach the end of the edit graph in no more than k edits, so
  // there's no point in considering any moves to diagonal k+1 any more (from
  // which we're guaranteed to need at least k+1 more edits).
  // Similarly, once we've reached the bottom of the edit graph, there's no
  // point considering moves to lower diagonals.
  let minDiagonalToConsider = -Infinity;
  let maxDiagonalToConsider = Infinity;

  while (editLength <= maxEditLength) {
    for (
      let diagonalPath = Math.max(minDiagonalToConsider, -editLength);
      diagonalPath <= Math.min(maxDiagonalToConsider, editLength);
      diagonalPath += 2
    ) {
      const removePath = bestPath.get(diagonalPath - 1);
      const addPath = bestPath.get(diagonalPath + 1);
      if (removePath) {
        // No one else is going to attempt to use this value, clear it
        bestPath.set(diagonalPath - 1, undefined);
      }

      let canAdd = false;
      if (addPath) {
        // what newPos will be after we do an insertion:
        const addPathNewPos = addPath.oldPos - diagonalPath;
        canAdd = 0 <= addPathNewPos && addPathNewPos < newLen;
      }

      const canRemove = removePath !== undefined && removePath.oldPos + 1 < oldLen;
      if (!canAdd && !canRemove) {
        // If this path is a terminal then prune
        bestPath.set(diagonalPath, undefined);
        continue;
      }

      // Select the diagonal that we want to branch from. We select the prior
      // path whose position in the old string is the farthest from the origin
      // and does not pass the bounds of the diff graph
      let basePath: DiffPath;
      if (addPath && canAdd && (!removePath || !canRemove || removePath.oldPos < addPath.oldPos)) {
        basePath = addToPath(addPath, true, false, 0);
      } else if (removePath) {
        basePath = addToPath(removePath, false, true, 1);
      } else {
        // Not reachable: without an add move, canRemove is true and removePath is set.
        continue;
      }

      newPos = extractCommon(basePath, newTokens, oldTokens, diagonalPath);

      if (basePath.oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
        // If we have hit the end of both strings, then we are done
        return buildValues(basePath.lastComponent, newTokens, oldTokens);
      }

      bestPath.set(diagonalPath, basePath);
      if (basePath.oldPos + 1 >= oldLen) {
        maxDiagonalToConsider = Math.min(maxDiagonalToConsider, diagonalPath - 1);
      }
      if (newPos + 1 >= newLen) {
        minDiagonalToConsider = Math.max(minDiagonalToConsider, diagonalPath + 1);
      }
    }

    editLength++;
  }

  // Not reachable: oldLen + newLen edits always reach the end of both texts.
  throw new Error("diffLines: no edit path found");
}
