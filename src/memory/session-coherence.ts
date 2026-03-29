/**
 * Intra-session coherence tracking + multi-turn intent tracking.
 *
 * Maintains a running structured extract of the current conversation:
 * active threads, decisions, open questions, pivots, and intent flow.
 *
 * Updated every N turns via lightweight heuristic extraction (no LLM).
 *
 * Plan 7, Phases 2 + 9.
 */

import crypto from "node:crypto";

// ── Phase 9: Conversational Act Classification ──

export type ConversationalAct =
  | "question"
  | "instruct"
  | "correct"
  | "elaborate"
  | "confirm"
  | "pivot"
  | "explore"
  | "unknown";

export interface IntentState {
  currentAct: ConversationalAct;
  actHistory: Array<{ act: ConversationalAct; turn: number }>;
  intentSummary: string;
}

// ── Phase 2: Session Thread Tracking ──

export interface SessionThread {
  id: string;
  topic: string;
  status: "active" | "paused" | "resolved";
  startedAtTurn: number;
  lastMentionedTurn: number;
  decisions: string[];
  openQuestions: string[];
}

export interface SessionCoherenceState {
  threads: SessionThread[];
  pivots: Array<{ turn: number; from: string; to: string }>;
  lastUpdatedTurn: number;
}

export class SessionCoherenceTracker {
  private state: SessionCoherenceState = {
    threads: [],
    pivots: [],
    lastUpdatedTurn: 0,
  };

  private intentState: IntentState = {
    currentAct: "unknown",
    actHistory: [],
    intentSummary: "",
  };

  constructor(
    private readonly updateInterval: number = 10,
    private readonly maxThreads: number = 5,
  ) {}

  /**
   * Process new messages since last update.
   * Uses heuristic extraction — no LLM calls.
   */
  update(
    messages: Array<{ role: string; content: string; turn: number }>,
    currentTurn: number,
  ): void {
    if (currentTurn - this.state.lastUpdatedTurn < this.updateInterval) return;

    const recentWindow = messages.slice(-this.updateInterval * 2);

    // 1. Extract topic mentions
    const topicCounts = this.extractTopicMentions(recentWindow);

    // 2. Detect decisions
    const decisions = this.extractDecisions(recentWindow);

    // 3. Detect open questions
    const questions = this.extractOpenQuestions(recentWindow);

    // 4. Detect pivots
    const pivots = this.extractPivots(recentWindow);

    // 5. Update threads
    this.updateThreads(topicCounts, decisions, questions, currentTurn);

    // 6. Record pivots
    for (const pivot of pivots) {
      this.state.pivots.push({ turn: currentTurn, ...pivot });
    }
    // Keep recent pivots only
    this.state.pivots = this.state.pivots.slice(-5);

    // 7. Age out stale threads
    for (const thread of this.state.threads) {
      if (currentTurn - thread.lastMentionedTurn > 20) {
        thread.status = "paused";
      }
    }

    // 8. Cap thread count
    if (this.state.threads.length > this.maxThreads) {
      this.state.threads.sort((a, b) =>
        a.status === "paused" && b.status !== "paused"
          ? 1
          : b.status === "paused" && a.status !== "paused"
            ? -1
            : b.lastMentionedTurn - a.lastMentionedTurn,
      );
      this.state.threads = this.state.threads.slice(0, this.maxThreads);
    }

    this.state.lastUpdatedTurn = currentTurn;
  }

  /**
   * Update intent state from latest user message (Phase 9).
   */
  updateIntent(userMessage: string, turn: number): void {
    const act = this.classifyAct(userMessage);
    this.intentState.currentAct = act;
    this.intentState.actHistory.push({ act, turn });

    if (this.intentState.actHistory.length > 20) {
      this.intentState.actHistory = this.intentState.actHistory.slice(-20);
    }

    this.intentState.intentSummary = this.summarizeIntentFlow();
  }

  /**
   * Classify a user message into a conversational act.
   */
  private classifyAct(message: string): ConversationalAct {
    const lower = message.toLowerCase().trim();

    if (/^(?:yes|yeah|yep|correct|right|perfect|exactly|that's right|looks good|lgtm)\b/i.test(lower)) {
      return "confirm";
    }
    if (/^(?:no[,.]?\s|nope|that's wrong|actually|wait|not what i|i meant)/i.test(lower)) {
      return "correct";
    }
    if (/^(?:forget that|scratch that|instead|wait.*let's|never ?mind|on second thought)/i.test(lower)) {
      return "pivot";
    }
    if (/^(?:what if|could we|i'm wondering|hypothetically|would it be possible)/i.test(lower)) {
      return "explore";
    }
    if (/^(?:and also|additionally|specifically|what i mean|to clarify|more precisely)/i.test(lower)) {
      return "elaborate";
    }
    if (/\?$/.test(lower) || /^(?:how|what|why|when|where|which|can you|do you|is there|does)/i.test(lower)) {
      return "question";
    }
    if (/^(?:build|create|add|change|update|fix|remove|delete|implement|write|make|set up|deploy|run|test)/i.test(lower)) {
      return "instruct";
    }

    return "unknown";
  }

  private summarizeIntentFlow(): string {
    const recent = this.intentState.actHistory.slice(-5);
    if (recent.length < 2) return "";

    const transitions: string[] = [];

    for (let i = 1; i < recent.length; i++) {
      const prev = recent[i - 1]!.act;
      const curr = recent[i]!.act;

      if (prev === "question" && curr === "instruct") {
        transitions.push("asked → now building");
      } else if (prev === "instruct" && curr === "correct") {
        transitions.push("building → correcting approach");
      } else if (curr === "pivot") {
        transitions.push("changed direction");
      } else if (prev === "explore" && curr === "instruct") {
        transitions.push("explored → now implementing");
      } else if (prev === "instruct" && curr === "question") {
        transitions.push("building → clarifying");
      }
    }

    return transitions.length > 0 ? transitions.join(", ") : "";
  }

  private extractTopicMentions(
    msgs: Array<{ content: string }>,
  ): Map<string, number> {
    const counts = new Map<string, number>();
    const techPattern =
      /\b(?:API|REST|GraphQL|auth|database|deploy|test|build|CI|CD|Docker|K8s|Kubernetes|React|Node|TypeScript|Python)\b/gi;

    for (const msg of msgs) {
      const text = typeof msg.content === "string" ? msg.content : "";
      const techs = text.match(techPattern) ?? [];
      for (const term of techs) {
        const normalized = term.toLowerCase();
        counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
      }
    }

    // Filter to terms mentioned 2+ times
    for (const [term, count] of counts) {
      if (count < 2) counts.delete(term);
    }
    return counts;
  }

  private extractDecisions(
    msgs: Array<{ role: string; content: string }>,
  ): string[] {
    const decisionPatterns = [
      /(?:let's|let us)\s+(.{10,80}?)(?:\.|$)/gi,
      /(?:we'll|we will)\s+(.{10,80}?)(?:\.|$)/gi,
      /(?:decided to|going with|chose|choosing)\s+(.{10,80}?)(?:\.|$)/gi,
      /(?:plan is to|approach:)\s+(.{10,80}?)(?:\.|$)/gi,
    ];

    const decisions: string[] = [];
    for (const msg of msgs) {
      const text = typeof msg.content === "string" ? msg.content : "";
      for (const pattern of decisionPatterns) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) {
          decisions.push(match[1]!.trim());
        }
      }
    }
    return decisions.slice(-5);
  }

  private extractOpenQuestions(
    msgs: Array<{ role: string; content: string; turn: number }>,
  ): string[] {
    const questions: Array<{ text: string; turn: number; role: string }> = [];
    const questionPattern = /([^.!?\n]{10,120}\?)/g;

    for (const msg of msgs) {
      const text = typeof msg.content === "string" ? msg.content : "";
      questionPattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = questionPattern.exec(text)) !== null) {
        questions.push({ text: match[1]!.trim(), turn: msg.turn, role: msg.role });
      }
    }

    // A question is "open" if no subsequent message from the other role
    // contains significant keyword overlap
    const open: string[] = [];
    for (const q of questions) {
      const qWords = new Set(
        q.text
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 3),
      );
      const answered = msgs.some(
        (m) =>
          m.turn > q.turn &&
          m.role !== q.role &&
          this.wordOverlap(qWords, m.content) > 0.3,
      );
      if (!answered) open.push(q.text);
    }
    return open.slice(-3);
  }

  private extractPivots(
    msgs: Array<{ role: string; content: string }>,
  ): Array<{ from: string; to: string }> {
    const pivotPattern =
      /(?:actually|instead|on second thought|wait|never mind|scratch that),?\s*(?:let's|let us|we should|can we)\s+(.{10,80}?)(?:\.|$)/gi;

    const pivots: Array<{ from: string; to: string }> = [];
    for (const msg of msgs) {
      if (msg.role !== "user") continue;
      const text = typeof msg.content === "string" ? msg.content : "";
      pivotPattern.lastIndex = 0;
      const match = pivotPattern.exec(text);
      if (match) {
        pivots.push({ from: "(previous approach)", to: match[1]!.trim() });
      }
    }
    return pivots;
  }

  private updateThreads(
    topicCounts: Map<string, number>,
    decisions: string[],
    questions: string[],
    currentTurn: number,
  ): void {
    for (const [topic] of topicCounts) {
      const existing = this.state.threads.find(
        (t) =>
          t.topic.toLowerCase().includes(topic) ||
          topic.includes(t.topic.toLowerCase()),
      );
      if (existing) {
        existing.lastMentionedTurn = currentTurn;
        existing.status = "active";
      } else if (this.state.threads.length < this.maxThreads) {
        this.state.threads.push({
          id: crypto.randomUUID().slice(0, 8),
          topic,
          status: "active",
          startedAtTurn: currentTurn,
          lastMentionedTurn: currentTurn,
          decisions: [],
          openQuestions: [],
        });
      }
    }

    const activeThread = this.state.threads.find((t) => t.status === "active");
    if (activeThread) {
      activeThread.decisions.push(...decisions);
      activeThread.decisions = activeThread.decisions.slice(-5);
      activeThread.openQuestions = questions;
    }
  }

  private wordOverlap(qWords: Set<string>, content: string): number {
    const cWords = new Set(
      content
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3),
    );
    let overlap = 0;
    for (const w of qWords) {
      if (cWords.has(w)) overlap++;
    }
    return qWords.size > 0 ? overlap / qWords.size : 0;
  }

  /**
   * Format for system prompt injection (~200-400 tokens).
   */
  formatForPrompt(): string | null {
    const active = this.state.threads.filter((t) => t.status === "active");
    if (active.length === 0 && !this.intentState.intentSummary) return null;

    const lines: string[] = ["Session context (do not announce):"];

    for (const thread of active) {
      lines.push(`- Topic: ${thread.topic}`);
      if (thread.decisions.length > 0) {
        lines.push(`  Decided: ${thread.decisions.slice(-2).join("; ")}`);
      }
      if (thread.openQuestions.length > 0) {
        lines.push(`  Open: ${thread.openQuestions[0]}`);
      }
    }

    const recentPivots = this.state.pivots.slice(-2);
    if (recentPivots.length > 0) {
      lines.push(
        `- User pivoted: ${recentPivots.map((p) => p.to).join("; ")}`,
      );
    }

    if (this.intentState.intentSummary) {
      lines.push(`- Flow: ${this.intentState.intentSummary}`);
    }

    return lines.join("\n");
  }

  /** Export for persistence (e.g., handover brief enrichment). */
  getState(): SessionCoherenceState {
    return structuredClone(this.state);
  }

  /** Import from persistence (session resume). */
  setState(state: SessionCoherenceState): void {
    this.state = structuredClone(state);
  }

  getIntentState(): IntentState {
    return structuredClone(this.intentState);
  }
}
