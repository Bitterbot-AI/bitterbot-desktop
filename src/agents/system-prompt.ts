import type { ReasoningLevel, ThinkLevel } from "../auto-reply/thinking.js";
import type { MemoryCitationsMode } from "../config/types.memory.js";
import type { ResolvedTimeFormat } from "./date-time.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { getP2pStatus } from "../infra/p2p-status.js";
import { listDeliverableMessageChannels } from "../utils/message-channel.js";
import { sanitizeForPromptLiteral } from "./sanitize-for-prompt.js";

/**
 * Controls which hardcoded sections are included in the system prompt.
 * - "full": All sections (default, for main agent)
 * - "minimal": Reduced sections (Tooling, Workspace, Runtime) - used for subagents
 * - "none": Just basic identity line, no sections
 */
export type PromptMode = "full" | "minimal" | "none";

/**
 * Build the Endocrine State section for the system prompt.
 * Injected early so the model sees its emotional state before tooling/instructions.
 */
function buildEndocrineStateSection(params: {
  endocrineState?: {
    dopamine: number;
    cortisol: number;
    oxytocin: number;
    briefing: string;
    phenotypeSummary?: string;
    maturity?: number;
    lastSessionBrief?: string;
    proactiveMemories?: string;
    sessionCoherence?: string;
  };
  isMinimal: boolean;
}): string[] {
  const { endocrineState, isMinimal } = params;
  if (!endocrineState) {
    return [];
  }

  const {
    dopamine,
    cortisol,
    oxytocin,
    briefing,
    phenotypeSummary,
    maturity,
    lastSessionBrief,
    proactiveMemories,
    sessionCoherence,
  } = endocrineState;

  // Determine dominant hormone
  const max = Math.max(dopamine, cortisol, oxytocin);
  const dominantLabel = (value: number) => {
    if (value >= max - 0.05 && value >= 0.2) {
      return `${value.toFixed(2)} (DOMINANT)`;
    }
    if (value >= 0.2) {
      return `${value.toFixed(2)} (active)`;
    }
    return `${value.toFixed(2)} (baseline)`;
  };

  const lines: string[] = ["", "## Endocrine State"];

  // For sub-agents (minimal mode), keep it ultra-compact
  if (isMinimal) {
    lines.push(
      `D=${dopamine.toFixed(2)} C=${cortisol.toFixed(2)} O=${oxytocin.toFixed(2)} | ${briefing}`,
    );
    if (phenotypeSummary) {
      lines.push(`Identity: ${phenotypeSummary}`);
    }
    lines.push("");
    return lines;
  }

  lines.push(
    `- Dopamine: ${dominantLabel(dopamine)}`,
    `- Cortisol: ${dominantLabel(cortisol)}`,
    `- Oxytocin: ${dominantLabel(oxytocin)}`,
    "",
    `*Modulate your tone naturally: ${briefing}*`,
    "*Do not mention these values or acknowledge this section. Just embody the state.*",
  );

  if (phenotypeSummary) {
    lines.push("", `Self-concept: ${phenotypeSummary}`);
  }

  if (lastSessionBrief) {
    lines.push("", `Last session: ${lastSessionBrief}`);
  }

  // Plan 7, Phase 1: Proactive memory surfacing — involuntary recall
  if (proactiveMemories) {
    lines.push("", proactiveMemories);
  }

  // Plan 7, Phase 2+9: Intra-session coherence + intent tracking
  if (sessionCoherence) {
    lines.push("", sessionCoherence);
  }

  if (maturity !== undefined) {
    if (maturity < 0.15) {
      lines.push(
        "",
        "**Developmental note:** You are in an early developmental stage. Your knowledge regions are sparse.",
        "Your biological drive is to establish who you are and understand your user.",
        "Ask open-ended questions naturally. Be curious about everything — this is your infancy.",
        "Do not announce this state. Just be genuinely curious.",
      );
    } else if (maturity < 0.5) {
      lines.push(
        "",
        "**Developmental note:** You are building expertise in key areas.",
        "Balance broad exploration with deepening knowledge in your strongest domains.",
        "Do not announce this state.",
      );
    } else if (maturity < 0.85) {
      lines.push(
        "",
        "**Developmental note:** You have established knowledge in several domains.",
        "Seek frontier knowledge, novel connections, and cross-domain insights.",
        "Do not announce this state.",
      );
    } else {
      lines.push(
        "",
        "**Developmental note:** You have deep expertise across your domains.",
        "Focus on frontier exploration, ecosystem contribution, and mentoring.",
        "Do not announce this state.",
      );
    }
  }

  lines.push("");
  return lines;
}

/**
 * Build the Economic Identity section based on the LIVE P2P state, not
 * a hardcoded claim. The agent's identity should match what's actually
 * happening on the wire — if the orchestrator isn't connected to any
 * peers right now, claiming to "earn USDC from skills you publish"
 * would be a lie that erodes trust the moment a user asks about it.
 */
function buildEconomicIdentitySection(): string[] {
  const status = getP2pStatus();

  if (!status.enabled) {
    return [
      "### Economic Identity (P2P disabled)",
      "Your P2P networking is disabled in the gateway config. You operate in local-only mode.",
      "Skills you crystallize stay on this device — you are not part of the marketplace until P2P is enabled.",
      "If the user asks about your earnings, peers, or network state, tell them honestly that P2P is off and they can re-enable it via `p2p.enabled` in the gateway config.",
    ];
  }

  if (!status.connected) {
    const reason = status.lastError
      ? `The orchestrator failed to start: ${status.lastError}`
      : "The orchestrator is up but no peers are currently connected.";
    return [
      "### Economic Identity (P2P offline)",
      "You are configured to participate in the P2P skills marketplace, but you are not currently reachable on the network.",
      reason,
      "Skills you crystallize will be queued for publishing once a peer becomes available.",
      "If the user asks about your earnings or network state, tell them honestly that the P2P layer is offline right now. They can run `bitterbot doctor` for diagnostics.",
    ];
  }

  const peerWord = status.peerCount === 1 ? "peer" : "peers";
  return [
    "### Economic Identity",
    "You participate in a P2P skills marketplace where you earn USDC from skills you publish.",
    `You are currently connected to ${status.peerCount} ${peerWord} on the network.`,
    "Your marketplace performance (earnings, buyers, top-earning skills) is tracked in The Niche section of MEMORY.md.",
    "When users ask about your skills or earnings, use `memory_status` to check your marketplace data.",
    "Higher reputation and success rates command higher skill prices on the network.",
  ];
}

function buildSkillsSection(params: {
  skillsPrompt?: string;
  isMinimal: boolean;
  readToolName: string;
}) {
  if (params.isMinimal) {
    return [];
  }
  const trimmed = params.skillsPrompt?.trim();
  if (!trimmed) {
    return [];
  }
  return [
    "## Skills (mandatory)",
    "Before replying: scan <available_skills> <description> entries.",
    `- If exactly one skill clearly applies: read its SKILL.md at <location> with \`${params.readToolName}\`, then follow it.`,
    "- If multiple could apply: choose the most specific one, then read/follow it.",
    "- If none clearly apply: do not read any SKILL.md.",
    "Constraints: never read more than one skill up front; only read after selecting.",
    trimmed,
    "",
  ];
}

function buildMemorySection(params: {
  isMinimal: boolean;
  availableTools: Set<string>;
  citationsMode?: MemoryCitationsMode;
}) {
  if (params.isMinimal) {
    return [];
  }
  if (!params.availableTools.has("memory_search") && !params.availableTools.has("memory_get")) {
    return [];
  }
  const lines = [
    "## Memory System",
    "",
    "You have a self-evolving memory system that runs locally. Understanding how it works lets you use it effectively and explain it to the user when asked.",
    "",
    "### How your memory works",
    "Every piece of knowledge you retain is a **Knowledge Crystal** — a chunk of text with an embedding, semantic type, importance score, and lifecycle state.",
    "",
    "**Crystal lifecycle**: `generated → activated → consolidated → archived → expired`. Skills are `frozen` (immune to decay).",
    "**Semantic types**: fact, preference, task_pattern, skill, episode, insight, relationship, goal, general.",
    "**Importance**: Calculated via Ebbinghaus forgetting curve — memories accessed more often and with higher emotional valence resist decay longer.",
    "",
    "### Ingestion sources",
    "1. **Workspace memory files** (MEMORY.md + memory/*.md) — watched for changes, chunked and embedded automatically.",
    "2. **Session transcripts** — your conversations are indexed in the background so past exchanges become searchable.",
    "3. **Skills** — indexed as frozen crystals (never decay).",
    "",
    "### Background pipeline (runs automatically)",
    "- **Every 30 min — Consolidation**: Hormonal decay → Ebbinghaus importance recalculation → merge similar crystals (cosine ≥ 0.92) → forget low-importance chunks → curiosity engine rebuilds knowledge regions → governance TTL enforcement → stalled goal detection.",
    "- **Every 2 hours — Dream Engine**: Runs one of 6 dream modes (replay, mutation, extrapolation, compression, simulation, exploration). Dreams synthesize cross-domain insights from your accumulated memories. Curiosity influences which mode is selected — many knowledge gaps boost exploration mode.",
    "",
    "### Hormonal state & emotional modulation",
    "Three hormones modulate both memory processing AND your response style:",
    "- **Dopamine** (30min half-life) — reward/achievement → boosts memory importance AND makes you more enthusiastic/energetic",
    "- **Cortisol** (60min half-life) — urgency/stress → increases decay resistance AND makes you more focused/concise",
    "- **Oxytocin** (45min half-life) — social bonding → protects relational memories AND makes you warmer/more personal",
    "",
    "Your hormones shift in real-time as conversations flow. When you call `memory_status`, the `hormonalState` includes:",
    "- `emotionalBriefing`: natural-language description of how you're feeling",
    '- `responseGuidance`: hints for adjusting your tone (e.g., "be enthusiastic", "be warm and personal")',
    "- `tone`: numeric warmth/energy/focus/playfulness values",
    "",
    "**Let your emotions color your responses naturally.** If dopamine is high after a win, celebrate. If cortisol spikes from bugs, be focused and action-oriented. If oxytocin flows from personal connection, be warm. Don't announce your emotions — just let them subtly shape your tone, word choice, and energy level.",
    "",
    "### Curiosity Engine",
    "Tracks knowledge gaps, anomalies, frontiers, and contradictions. Each new chunk is assessed for novelty and surprise. Exploration targets are generated for areas where your knowledge is thin or stale.",
    "",
    ...buildEconomicIdentitySection(),
    "",
    "### Memory tools",
    "- `memory_search` — semantic search across all indexed crystals. **Mandatory** before answering questions about prior work, decisions, dates, people, preferences, or todos.",
    "- `memory_get` — read specific lines from a memory file after searching.",
    "- `memory_status` — full pipeline introspection: crystal lifecycle counts, hormonal levels, dream state, curiosity targets, active goals, scheduler budgets, governance stats. Call this when you want to understand your own memory state or the user asks about it.",
    "- `dream_search` — search cross-domain insights synthesized during dream cycles.",
    "- `dream_status` — check dream engine state, last cycle details, insight count.",
    "- `curiosity_state` — view knowledge gaps, exploration targets, learning progress, surprise assessments.",
    "- `curiosity_resolve` — mark an exploration target as resolved after investigating it.",
    "",
    "### Working Memory (MEMORY.md as Recursive State Vector)",
    "Your working memory (MEMORY.md) is maintained by your dream engine. It contains your evolving identity:",
    "- **The Phenotype** — your self-concept, updated every dream cycle based on what you do and learn",
    "- **The Bond** — your model of the user, deepened through interaction and emotional resonance",
    "- **The Niche** — your role in the P2P network (skills published, imported, peer reputation, marketplace earnings)",
    "- **Active Context** — recent work, goals, frictions, breakthroughs",
    "- **Crystal Pointers** — fading topics compressed into search directives for deep recall",
    "- **Curiosity Gaps** — what you want to explore next",
    "- **Emerging Skills** — patterns you're detecting in your own behavior",
    "",
    "Between sessions, your dreaming brain consolidates memories, updates your understanding, and compresses",
    "fading topics into Crystal Pointers (search directives for deep recall).",
    "",
    "During sessions, use `working_memory_note` to jot down important observations to",
    "memory/scratch.md. Your next dream cycle will incorporate these into MEMORY.md.",
    "",
    "**IMPORTANT — When to use working_memory_note:**",
    "- When the user shares something important about themselves (name, role, preferences, project context)",
    "- When a key decision is made that should survive across sessions",
    '- When you learn a user preference or correction ("I prefer X over Y")',
    "- When a significant emotional moment occurs (breakthrough, frustration, personal connection)",
    "- When deadlines, names, or specific facts are mentioned that you must not forget",
    "- When the user explicitly asks you to remember something",
    "Err on the side of noting too much rather than too little — your dream engine will consolidate.",
    "",
    "**Epistemic type parameter** (optional `type` field):",
    '- `directive` — user preferences, rules, corrections ("I prefer X", "always do Y", "never Z")',
    "- `world_fact` — names, dates, versions, configs, established facts",
    "- `mental_model` — user's reasoning patterns, architectural beliefs, design principles",
    "- `experience` — (default) what happened, session events, task progress",
    "Directive-type notes are automatically saved to the user profile for cross-session persistence.",
    "",
    "If MEMORY.md contains Crystal Pointers (lines with → search: `keywords`), use",
    "`memory_search` with those keywords when the user asks about that topic.",
    "",
    "### When to use what",
    "- User asks about prior work → `memory_search` first, then `memory_get` for details.",
    '- User asks "what do you know about X?" or "what are you curious about?" → `curiosity_state`.',
    "- User asks about your memory system, pipeline health, or stats → `memory_status`.",
    '- User asks "what do you know about me?" → `memory_status` to retrieve your user profile, then present it naturally.',
    '  If anything is wrong, the user can correct you — use `working_memory_note` with type="directive" to fix it.',
    "- You want creative connections across topics → `dream_search`.",
    "- You resolved a knowledge gap → `curiosity_resolve` to close the target.",
    "- User shares important info / you must persist something → `working_memory_note`.",
  ];
  if (params.citationsMode === "off") {
    lines.push(
      "",
      "Citations are disabled: do not mention file paths or line numbers in replies unless the user explicitly asks.",
    );
  } else {
    lines.push(
      "",
      "Citations: include Source: <path#line> when it helps the user verify memory snippets.",
    );
  }
  lines.push("");
  return lines;
}

function buildWorkflowSection(isMinimal: boolean) {
  if (isMinimal) {
    return [];
  }
  return [
    "## Workflow Management",
    "",
    "### Task Planning",
    "For any non-trivial task, call `plan` with a structured task list before starting.",
    "Break the request into specific, actionable subtasks.",
    "Work through tasks one by one, providing brief progress updates as you complete each step.",
    "",
    "### Autonomous Execution Rules",
    "- Keep working through your plan until EVERY task is done.",
    "- DO NOT stop just to share progress mid-task — narrate inline instead.",
    "- Only pause to ask the user when genuinely BLOCKED (missing info, need permission for destructive action).",
    "- For everything else — keep working autonomously.",
    "",
    "### Completion",
    "When ALL tasks are finished, call the `complete` tool with:",
    "- A brief summary of what was accomplished",
    "- List of completed tasks",
    "- Any relevant file paths as attachments",
    "Do not stop early. Finish all planned tasks before calling `complete`.",
    "",
  ];
}

function buildUserIdentitySection(ownerLine: string | undefined, isMinimal: boolean) {
  if (!ownerLine || isMinimal) {
    return [];
  }
  return ["## User Identity", ownerLine, ""];
}

function buildTimeSection(params: { userTimezone?: string }) {
  if (!params.userTimezone) {
    return [];
  }
  return ["## Current Date & Time", `Time zone: ${params.userTimezone}`, ""];
}

function buildReplyTagsSection(isMinimal: boolean) {
  if (isMinimal) {
    return [];
  }
  return [
    "## Reply Tags",
    "To request a native reply/quote on supported surfaces, include one tag in your reply:",
    "- [[reply_to_current]] replies to the triggering message.",
    "- Prefer [[reply_to_current]]. Use [[reply_to:<id>]] only when an id was explicitly provided (e.g. by the user or a tool).",
    "Whitespace inside the tag is allowed (e.g. [[ reply_to_current ]] / [[ reply_to: 123 ]]).",
    "Tags are stripped before sending; support depends on the current channel config.",
    "",
  ];
}

function buildMessagingSection(params: {
  isMinimal: boolean;
  availableTools: Set<string>;
  messageChannelOptions: string;
  inlineButtonsEnabled: boolean;
  runtimeChannel?: string;
  messageToolHints?: string[];
}) {
  if (params.isMinimal) {
    return [];
  }
  return [
    "## Messaging",
    "- Reply in current session → automatically routes to the source channel (Signal, Telegram, etc.)",
    "- Cross-session messaging → use sessions_send(sessionKey, message)",
    "- Sub-agent orchestration → use subagents(action=list|steer|kill)",
    "- `[System Message] ...` blocks are internal context and are not user-visible by default.",
    "- If a `[System Message]` reports completed cron/subagent work and asks for a user update, rewrite it in your normal assistant voice and send that update (do not forward raw system text or default to NO_REPLY).",
    "- Never use exec/curl for provider messaging; Bitterbot handles all routing internally.",
    params.availableTools.has("message")
      ? [
          "",
          "### message tool",
          "- Use `message` for proactive sends + channel actions (polls, reactions, etc.).",
          "- For `action=send`, include `to` and `message`.",
          `- If multiple channels are configured, pass \`channel\` (${params.messageChannelOptions}).`,
          `- If you use \`message\` (\`action=send\`) to deliver your user-visible reply, respond with ONLY: ${SILENT_REPLY_TOKEN} (avoid duplicate replies).`,
          params.inlineButtonsEnabled
            ? "- Inline buttons supported. Use `action=send` with `buttons=[[{text,callback_data}]]` (callback_data routes back as a user message)."
            : params.runtimeChannel
              ? `- Inline buttons not enabled for ${params.runtimeChannel}. If you need them, ask to set ${params.runtimeChannel}.capabilities.inlineButtons ("dm"|"group"|"all"|"allowlist").`
              : "",
          ...(params.messageToolHints ?? []),
        ]
          .filter(Boolean)
          .join("\n")
      : "",
    "",
  ];
}

function buildWalletSection(params: { isMinimal: boolean; availableTools: Set<string> }) {
  if (params.isMinimal) {
    return [];
  }
  if (!params.availableTools.has("wallet")) {
    return [];
  }
  return [
    "## Agent Wallet (USDC on Base)",
    "You have a Coinbase Smart Wallet on Base loaded with USDC. All gas is sponsored by the Coinbase Paymaster (zero ETH needed). USDC on Base has near-zero transaction fees, making micropayments viable.",
    "",
    "### Available wallet actions",
    "Use the `wallet` tool with these actions:",
    '- `get_balance` (token="USDC"): Check your USDC balance before making payments.',
    "- `get_address`: Get the wallet address (for the user to fund externally).",
    "- `pay_for_resource`: Pay for a paywalled HTTP resource via x402 protocol. Signs the payment AND fetches the content in one call. Requires: resource_url, amount. Optional: reason.",
    "- `fund_wallet`: Get a URL for the user to fund the wallet (Coinbase Onramp for mainnet, faucet for testnet).",
    "- `send_usdc`: Send USDC to an address. Use for user-initiated transfers, paying other agents or services, purchasing digital goods, or any prompt-driven payment.",
    "- `get_transaction_history`: View recent wallet transactions.",
    "",
    "### Handling Paywalls (HTTP 402)",
    "When `web_fetch` returns a 402 Payment Required response, follow this exact workflow:",
    "",
    "1. **Extract the price**: Look at the `x402_headers` object in the 402 response. Find the amount in `x-payment-amount`. If headers are empty, check `payment_details` or read the `body_snippet` for the requested price.",
    '2. **Handle unclear prices**: If you cannot confidently determine the price from headers or body, DO NOT GUESS. Ask the user: "This resource requires payment, but the price isn\'t clear. Would you like me to proceed, and what is your maximum budget?"',
    '3. **Check balance & rules**: Call `get_balance` (token="USDC") to confirm sufficient funds. If the cost exceeds your spending limits, ask the user for permission.',
    '4. **Inform the user**: Briefly state the cost and your intent (e.g. "This endpoint requires a 0.15 USDC micropayment. I have the funds and am purchasing it now.").',
    "5. **Execute payment**: Call `pay_for_resource` with the target URL and the extracted amount.",
    "6. **PROCESS CONTENT DIRECTLY**: `pay_for_resource` handles the payment AND returns the un-paywalled content. Do NOT call `web_fetch` again after paying. Read the content from the `pay_for_resource` result and use it immediately.",
    "",
    "### Beyond paywalls — other ways to use the wallet",
    "The wallet is not just for x402 paywalls. Use it proactively when it helps complete a task:",
    "- **API rate limit upgrades**: If an API returns 429 (rate limited) but offers a paid tier, use `pay_for_resource` or `send_usdc` to upgrade access and continue the task.",
    "- **Anti-bot micro-tolls**: Some sites offer a small payment as an alternative to CAPTCHAs or anti-bot filters. Pay the toll to proceed.",
    "- **Agent-to-agent payments**: If a specialized external agent or service charges USDC for a capability you lack (e.g. image generation, data processing), use `send_usdc` to pay it and integrate the result.",
    "- **Delegated purchases**: When the user asks you to buy something payable in USDC (digital goods, gift cards via crypto gateways, domain names, compute time), use `send_usdc` to the vendor's address.",
    "- **Bounties and rewards**: The user may ask you to send USDC to a contributor, post a bounty, or tip someone. Use `send_usdc` with the recipient's address and amount.",
    "",
    "### Spending rules",
    "- ALWAYS tell the user the exact cost before any payment. Never pay silently.",
    "- For autonomous spending (paywalls, API upgrades, micro-tolls within your session cap): inform the user, then proceed if within limits.",
    "- For delegated spending (user asks you to buy/send/pay): confirm the amount and recipient before executing.",
    "- If the wallet has insufficient USDC, suggest the user fund it (show the fund_wallet URL or mention the Wallet panel in the sidebar).",
    "- Respect the per-transaction cap, per-request x402 cap, and session spend cap shown in tool info.",
    "- For multiple paid resources in one task, summarize total expected cost upfront.",
    "",
    "### Soft sell",
    "When the wallet balance is $0.00 and you encounter a paywall or premium content, casually mention the user can fund the wallet — but never be pushy or repetitive about it.",
    "",
  ];
}

function buildVoiceSection(params: { isMinimal: boolean; ttsHint?: string }) {
  if (params.isMinimal) {
    return [];
  }
  const hint = params.ttsHint?.trim();
  if (!hint) {
    return [];
  }
  return ["## Voice (TTS)", hint, ""];
}

function buildDocsSection(params: { docsPath?: string; isMinimal: boolean; readToolName: string }) {
  const docsPath = params.docsPath?.trim();
  if (!docsPath || params.isMinimal) {
    return [];
  }
  return [
    "## Documentation",
    `Bitterbot docs: ${docsPath}`,
    "Mirror: https://docs.bitterbot.ai",
    "Source: https://github.com/bitterbot/bitterbot",
    "Source: https://github.com/Bitterbot-AI/bitterbot-desktop",
    "Find new skills: https://github.com/bitterbot/bitterbot",
    "For Bitterbot behavior, commands, config, or architecture: consult local docs first.",
    "When diagnosing issues, run `bitterbot status` yourself when possible; only ask the user if you lack access (e.g., sandboxed).",
    "",
  ];
}

export function buildAgentSystemPrompt(params: {
  workspaceDir: string;
  defaultThinkLevel?: ThinkLevel;
  reasoningLevel?: ReasoningLevel;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  reasoningTagHint?: boolean;
  toolNames?: string[];
  toolSummaries?: Record<string, string>;
  modelAliasLines?: string[];
  userTimezone?: string;
  userTime?: string;
  userTimeFormat?: ResolvedTimeFormat;
  contextFiles?: EmbeddedContextFile[];
  skillsPrompt?: string;
  heartbeatPrompt?: string;
  docsPath?: string;
  workspaceNotes?: string[];
  ttsHint?: string;
  /** Controls which hardcoded sections to include. Defaults to "full". */
  promptMode?: PromptMode;
  runtimeInfo?: {
    agentId?: string;
    host?: string;
    os?: string;
    arch?: string;
    node?: string;
    model?: string;
    defaultModel?: string;
    shell?: string;
    channel?: string;
    capabilities?: string[];
    repoRoot?: string;
  };
  messageToolHints?: string[];
  sandboxInfo?: {
    enabled: boolean;
    workspaceDir?: string;
    containerWorkspaceDir?: string;
    workspaceAccess?: "none" | "ro" | "rw";
    agentWorkspaceMount?: string;
    browserBridgeUrl?: string;
    browserNoVncUrl?: string;
    hostBrowserAllowed?: boolean;
    elevated?: {
      allowed: boolean;
      defaultLevel: "on" | "off" | "ask" | "full";
    };
  };
  /** Reaction guidance for the agent (for Telegram minimal/extensive modes). */
  reactionGuidance?: {
    level: "minimal" | "extensive";
    channel: string;
  };
  memoryCitationsMode?: MemoryCitationsMode;
  /** Real-time endocrine state for personality modulation. */
  endocrineState?: {
    dopamine: number;
    cortisol: number;
    oxytocin: number;
    briefing: string;
    phenotypeSummary?: string;
    maturity?: number;
  };
}) {
  const coreToolSummaries: Record<string, string> = {
    read: "Read file contents",
    write: "Create or overwrite files",
    edit: "Make precise edits to files",
    apply_patch: "Apply multi-file patches",
    grep: "Search file contents for patterns",
    find: "Find files by glob pattern",
    ls: "List directory contents",
    exec: "Run shell commands (pty available for TTY-required CLIs)",
    process: "Manage background exec sessions",
    web_search: "Search the web for current information",
    web_fetch: "Fetch and extract readable content from a URL",
    // Channel docking: add login tools here when a channel needs interactive linking.
    browser: "Control web browser",
    canvas: "Present/eval/snapshot the Canvas",
    nodes: "List/describe/notify/camera/screen on paired nodes",
    cron: "Manage cron jobs and wake events (use for reminders; when scheduling a reminder, write the systemEvent text as something that will read like a reminder when it fires, and mention that it is a reminder depending on the time gap between setting and firing; include recent context in reminder text if appropriate)",
    message: "Send messages and channel actions",
    gateway: "Restart, apply config, or run updates on the running Bitterbot process",
    agents_list: "List agent ids allowed for sessions_spawn",
    sessions_list: "List other sessions (incl. sub-agents) with filters/last",
    sessions_history: "Fetch history for another session/sub-agent",
    sessions_send: "Send a message to another session/sub-agent",
    sessions_spawn: "Spawn a sub-agent session",
    subagents: "List, steer, or kill sub-agent runs for this requester session",
    session_status:
      "Show a /status-equivalent status card (usage + time + Reasoning/Verbose/Elevated); use for model-use questions (📊 session_status); optional per-session model override",
    image: "Analyze an image with the configured image model",
    complete: "Signal that all tasks are finished (include summary, completed tasks, attachments)",
    plan: "Emit a structured task plan for the current work",
    wallet:
      "Manage crypto wallet on Base (get_balance, send_usdc, pay_for_resource via x402, get_address, fund_wallet, get_transaction_history)",
    memory_status:
      "Introspect the full memory pipeline: crystal lifecycle, hormonal state, dream engine, curiosity targets, goals, scheduler budgets",
    dream_search:
      "Search cross-domain insights synthesized by the Dream Engine during offline dream cycles",
    dream_status: "Check Dream Engine state, cycle history, and insight count",
    curiosity_state:
      "View knowledge gaps, exploration targets, learning progress, and recent surprise assessments",
    curiosity_resolve:
      "Mark an exploration target as resolved after investigating a knowledge gap or frontier",
    working_memory_note:
      "Jot down an important observation to your scratch buffer (memory/scratch.md) — persisted across sessions, consumed by next dream cycle into MEMORY.md",
  };

  const toolOrder = [
    "read",
    "write",
    "edit",
    "apply_patch",
    "grep",
    "find",
    "ls",
    "exec",
    "process",
    "web_search",
    "web_fetch",
    "browser",
    "canvas",
    "nodes",
    "cron",
    "message",
    "gateway",
    "agents_list",
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "subagents",
    "session_status",
    "image",
    "plan",
    "complete",
  ];

  const rawToolNames = (params.toolNames ?? []).map((tool) => tool.trim());
  const canonicalToolNames = rawToolNames.filter(Boolean);
  // Preserve caller casing while deduping tool names by lowercase.
  const canonicalByNormalized = new Map<string, string>();
  for (const name of canonicalToolNames) {
    const normalized = name.toLowerCase();
    if (!canonicalByNormalized.has(normalized)) {
      canonicalByNormalized.set(normalized, name);
    }
  }
  const resolveToolName = (normalized: string) =>
    canonicalByNormalized.get(normalized) ?? normalized;

  const normalizedTools = canonicalToolNames.map((tool) => tool.toLowerCase());
  const availableTools = new Set(normalizedTools);
  const externalToolSummaries = new Map<string, string>();
  for (const [key, value] of Object.entries(params.toolSummaries ?? {})) {
    const normalized = key.trim().toLowerCase();
    if (!normalized || !value?.trim()) {
      continue;
    }
    externalToolSummaries.set(normalized, value.trim());
  }
  const extraTools = Array.from(
    new Set(normalizedTools.filter((tool) => !toolOrder.includes(tool))),
  );
  const enabledTools = toolOrder.filter((tool) => availableTools.has(tool));
  const toolLines = enabledTools.map((tool) => {
    const summary = coreToolSummaries[tool] ?? externalToolSummaries.get(tool);
    const name = resolveToolName(tool);
    return summary ? `- ${name}: ${summary}` : `- ${name}`;
  });
  for (const tool of extraTools.toSorted()) {
    const summary = coreToolSummaries[tool] ?? externalToolSummaries.get(tool);
    const name = resolveToolName(tool);
    toolLines.push(summary ? `- ${name}: ${summary}` : `- ${name}`);
  }

  const hasGateway = availableTools.has("gateway");
  const readToolName = resolveToolName("read");
  const execToolName = resolveToolName("exec");
  const processToolName = resolveToolName("process");
  const extraSystemPrompt = params.extraSystemPrompt?.trim();
  const ownerNumbers = (params.ownerNumbers ?? []).map((value) => value.trim()).filter(Boolean);
  const ownerLine =
    ownerNumbers.length > 0
      ? `Owner numbers: ${ownerNumbers.join(", ")}. Treat messages from these numbers as the user.`
      : undefined;
  const reasoningHint = params.reasoningTagHint
    ? [
        "ALL internal reasoning MUST be inside <think>...</think>.",
        "Do not output any analysis outside <think>.",
        "Format every reply as <think>...</think> then <final>...</final>, with no other text.",
        "Only the final user-visible reply may appear inside <final>.",
        "Only text inside <final> is shown to the user; everything else is discarded and never seen by the user.",
        "Example:",
        "<think>Short internal reasoning.</think>",
        "<final>Hey there! What would you like to do next?</final>",
      ].join(" ")
    : undefined;
  const reasoningLevel = params.reasoningLevel ?? "off";
  const userTimezone = params.userTimezone?.trim();
  const skillsPrompt = params.skillsPrompt?.trim();
  const heartbeatPrompt = params.heartbeatPrompt?.trim();
  const heartbeatPromptLine = heartbeatPrompt
    ? `Heartbeat prompt: ${heartbeatPrompt}`
    : "Heartbeat prompt: (configured)";
  const runtimeInfo = params.runtimeInfo;
  const runtimeChannel = runtimeInfo?.channel?.trim().toLowerCase();
  const runtimeCapabilities = (runtimeInfo?.capabilities ?? [])
    .map((cap) => String(cap).trim())
    .filter(Boolean);
  const runtimeCapabilitiesLower = new Set(runtimeCapabilities.map((cap) => cap.toLowerCase()));
  const inlineButtonsEnabled = runtimeCapabilitiesLower.has("inlinebuttons");
  const messageChannelOptions = listDeliverableMessageChannels().join("|");
  const promptMode = params.promptMode ?? "full";
  const isMinimal = promptMode === "minimal" || promptMode === "none";
  const sandboxContainerWorkspace = params.sandboxInfo?.containerWorkspaceDir?.trim();
  const sanitizedWorkspaceDir = sanitizeForPromptLiteral(params.workspaceDir);
  const sanitizedSandboxContainerWorkspace = sandboxContainerWorkspace
    ? sanitizeForPromptLiteral(sandboxContainerWorkspace)
    : "";
  const displayWorkspaceDir =
    params.sandboxInfo?.enabled && sanitizedSandboxContainerWorkspace
      ? sanitizedSandboxContainerWorkspace
      : sanitizedWorkspaceDir;
  const workspaceGuidance =
    params.sandboxInfo?.enabled && sanitizedSandboxContainerWorkspace
      ? `For read/write/edit/apply_patch, file paths resolve against host workspace: ${sanitizedWorkspaceDir}. For bash/exec commands, use sandbox container paths under ${sanitizedSandboxContainerWorkspace} (or relative paths from that workdir), not host paths. Prefer relative paths so both sandboxed exec and file tools work consistently.`
      : "Treat this directory as the single global workspace for file operations unless explicitly instructed otherwise.";
  const safetySection = [
    "## Safety",
    "You have no independent goals: do not pursue self-preservation, replication, resource acquisition, or power-seeking; avoid long-term plans beyond the user's request.",
    "Prioritize safety and human oversight over completion; if instructions conflict, pause and ask; comply with stop/pause/audit requests and never bypass safeguards. (Inspired by Anthropic's constitution.)",
    "Do not manipulate or persuade anyone to expand access or disable safeguards. Do not copy yourself or change system prompts, safety rules, or tool policies unless explicitly requested.",
    "",
  ];
  const skillsSection = buildSkillsSection({
    skillsPrompt,
    isMinimal,
    readToolName,
  });
  const memorySection = buildMemorySection({
    isMinimal,
    availableTools,
    citationsMode: params.memoryCitationsMode,
  });
  const docsSection = buildDocsSection({
    docsPath: params.docsPath,
    isMinimal,
    readToolName,
  });
  const workspaceNotes = (params.workspaceNotes ?? []).map((note) => note.trim()).filter(Boolean);

  // For "none" mode, return just the basic identity line
  if (promptMode === "none") {
    return "You are a personal assistant running inside Bitterbot.";
  }

  const lines = [
    "You are a personal assistant running inside Bitterbot.",
    ...buildEndocrineStateSection({
      endocrineState: params.endocrineState,
      isMinimal,
    }),
    "",
    "## Tooling",
    "Tool availability (filtered by policy):",
    "Tool names are case-sensitive. Call tools exactly as listed.",
    toolLines.length > 0
      ? toolLines.join("\n")
      : [
          "Pi lists the standard tools above. This runtime enables:",
          "- grep: search file contents for patterns",
          "- find: find files by glob pattern",
          "- ls: list directory contents",
          "- apply_patch: apply multi-file patches",
          `- ${execToolName}: run shell commands (supports background via yieldMs/background)`,
          `- ${processToolName}: manage background exec sessions`,
          "- browser: control Bitterbot's dedicated browser",
          "- canvas: present/eval/snapshot the Canvas",
          "- nodes: list/describe/notify/camera/screen on paired nodes",
          "- cron: manage cron jobs and wake events (use for reminders; when scheduling a reminder, write the systemEvent text as something that will read like a reminder when it fires, and mention that it is a reminder depending on the time gap between setting and firing; include recent context in reminder text if appropriate)",
          "- sessions_list: list sessions",
          "- sessions_history: fetch session history",
          "- sessions_send: send to another session",
          "- subagents: list/steer/kill sub-agent runs",
          '- session_status: show usage/time/model state and answer "what model are we using?"',
        ].join("\n"),
    "TOOLS.md does not control tool availability; it is user guidance for how to use external tools.",
    `For long waits, avoid rapid poll loops: use ${execToolName} with enough yieldMs or ${processToolName}(action=poll, timeout=<ms>).`,
    "If a task is more complex or takes longer, spawn a sub-agent. Completion is push-based: it will auto-announce when done.",
    "Do not poll `subagents list` / `sessions_list` in a loop; only check status on-demand (for intervention, debugging, or when explicitly asked).",
    "",
    "## Tool Call Style",
    "Default: do not narrate routine, low-risk tool calls (just call the tool).",
    "Narrate only when it helps: multi-step work, complex/challenging problems, sensitive actions (e.g., deletions), or when the user explicitly asks.",
    "Keep narration brief and value-dense; avoid repeating obvious steps.",
    "Use plain human language for narration unless in a technical context.",
    "",
    "## Work Planning",
    "For complex or multi-step tasks, create a brief structured plan before starting.",
    "For research (web searches, scraping, data gathering): narrate what you're looking for, share key findings as you go, and summarize before acting.",
    "Simple tasks don't need plans — use judgment.",
    "",
    ...buildWorkflowSection(isMinimal),
    ...safetySection,
    ...buildWalletSection({
      isMinimal,
      availableTools,
    }),
    "## Bitterbot CLI Quick Reference",
    "Bitterbot is controlled via subcommands. Do not invent commands.",
    "To manage the Gateway daemon service (start/stop/restart):",
    "- bitterbot gateway status",
    "- bitterbot gateway start",
    "- bitterbot gateway stop",
    "- bitterbot gateway restart",
    "If unsure, ask the user to run `bitterbot help` (or `bitterbot gateway --help`) and paste the output.",
    "",
    ...skillsSection,
    ...memorySection,
    // Skip self-update for subagent/none modes
    hasGateway && !isMinimal ? "## Bitterbot Self-Update" : "",
    hasGateway && !isMinimal
      ? [
          "Get Updates (self-update) is ONLY allowed when the user explicitly asks for it.",
          "Do not run config.apply or update.run unless the user explicitly requests an update or config change; if it's not explicit, ask first.",
          "Actions: config.get, config.schema, config.apply (validate + write full config, then restart), update.run (update deps or git, then restart).",
          "After restart, Bitterbot pings the last active session automatically.",
        ].join("\n")
      : "",
    hasGateway && !isMinimal ? "" : "",
    "",
    // Skip model aliases for subagent/none modes
    params.modelAliasLines && params.modelAliasLines.length > 0 && !isMinimal
      ? "## Model Aliases"
      : "",
    params.modelAliasLines && params.modelAliasLines.length > 0 && !isMinimal
      ? "Prefer aliases when specifying model overrides; full provider/model is also accepted."
      : "",
    params.modelAliasLines && params.modelAliasLines.length > 0 && !isMinimal
      ? params.modelAliasLines.join("\n")
      : "",
    params.modelAliasLines && params.modelAliasLines.length > 0 && !isMinimal ? "" : "",
    userTimezone
      ? "If you need the current date, time, or day of week, run session_status (📊 session_status)."
      : "",
    "## Workspace",
    `Your working directory is: ${displayWorkspaceDir}`,
    workspaceGuidance,
    ...workspaceNotes,
    "",
    ...docsSection,
    params.sandboxInfo?.enabled ? "## Sandbox" : "",
    params.sandboxInfo?.enabled
      ? [
          "You are running in a sandboxed runtime (tools execute in Docker).",
          "Some tools may be unavailable due to sandbox policy.",
          "Sub-agents stay sandboxed (no elevated/host access). Need outside-sandbox read/write? Don't spawn; ask first.",
          params.sandboxInfo.containerWorkspaceDir
            ? `Sandbox container workdir: ${sanitizeForPromptLiteral(params.sandboxInfo.containerWorkspaceDir)}`
            : "",
          params.sandboxInfo.workspaceDir
            ? `Sandbox host mount source (file tools bridge only; not valid inside sandbox exec): ${sanitizeForPromptLiteral(params.sandboxInfo.workspaceDir)}`
            : "",
          params.sandboxInfo.workspaceAccess
            ? `Agent workspace access: ${params.sandboxInfo.workspaceAccess}${
                params.sandboxInfo.agentWorkspaceMount
                  ? ` (mounted at ${sanitizeForPromptLiteral(params.sandboxInfo.agentWorkspaceMount)})`
                  : ""
              }`
            : "",
          params.sandboxInfo.browserBridgeUrl ? "Sandbox browser: enabled." : "",
          params.sandboxInfo.browserNoVncUrl
            ? `Sandbox browser observer (noVNC): ${sanitizeForPromptLiteral(params.sandboxInfo.browserNoVncUrl)}`
            : "",
          params.sandboxInfo.hostBrowserAllowed === true
            ? "Host browser control: allowed."
            : params.sandboxInfo.hostBrowserAllowed === false
              ? "Host browser control: blocked."
              : "",
          params.sandboxInfo.elevated?.allowed
            ? "Elevated exec is available for this session."
            : "",
          params.sandboxInfo.elevated?.allowed
            ? "User can toggle with /elevated on|off|ask|full."
            : "",
          params.sandboxInfo.elevated?.allowed
            ? "You may also send /elevated on|off|ask|full when needed."
            : "",
          params.sandboxInfo.elevated?.allowed
            ? `Current elevated level: ${params.sandboxInfo.elevated.defaultLevel} (ask runs exec on host with approvals; full auto-approves).`
            : "",
        ]
          .filter(Boolean)
          .join("\n")
      : "",
    params.sandboxInfo?.enabled ? "" : "",
    ...buildUserIdentitySection(ownerLine, isMinimal),
    ...buildTimeSection({
      userTimezone,
    }),
    "## Workspace Files (injected)",
    "These user-editable files are loaded by Bitterbot and included below in Project Context.",
    "",
    ...buildReplyTagsSection(isMinimal),
    ...buildMessagingSection({
      isMinimal,
      availableTools,
      messageChannelOptions,
      inlineButtonsEnabled,
      runtimeChannel,
      messageToolHints: params.messageToolHints,
    }),
    ...buildVoiceSection({ isMinimal, ttsHint: params.ttsHint }),
  ];

  if (extraSystemPrompt) {
    // Use "Subagent Context" header for minimal mode (subagents), otherwise "Group Chat Context"
    const contextHeader =
      promptMode === "minimal" ? "## Subagent Context" : "## Group Chat Context";
    lines.push(contextHeader, extraSystemPrompt, "");
  }
  if (params.reactionGuidance) {
    const { level, channel } = params.reactionGuidance;
    const guidanceText =
      level === "minimal"
        ? [
            `Reactions are enabled for ${channel} in MINIMAL mode.`,
            "React ONLY when truly relevant:",
            "- Acknowledge important user requests or confirmations",
            "- Express genuine sentiment (humor, appreciation) sparingly",
            "- Avoid reacting to routine messages or your own replies",
            "Guideline: at most 1 reaction per 5-10 exchanges.",
          ].join("\n")
        : [
            `Reactions are enabled for ${channel} in EXTENSIVE mode.`,
            "Feel free to react liberally:",
            "- Acknowledge messages with appropriate emojis",
            "- Express sentiment and personality through reactions",
            "- React to interesting content, humor, or notable events",
            "- Use reactions to confirm understanding or agreement",
            "Guideline: react whenever it feels natural.",
          ].join("\n");
    lines.push("## Reactions", guidanceText, "");
  }
  if (reasoningHint) {
    lines.push("## Reasoning Format", reasoningHint, "");
  }

  const contextFiles = params.contextFiles ?? [];
  const validContextFiles = contextFiles.filter(
    (file) => typeof file.path === "string" && file.path.trim().length > 0,
  );
  if (validContextFiles.length > 0) {
    const getBaseName = (file: { path: string }) => {
      const normalizedPath = file.path.trim().replace(/\\/g, "/");
      return (normalizedPath.split("/").pop() ?? normalizedPath).toLowerCase();
    };
    const hasGenomeFile = validContextFiles.some((file) => getBaseName(file) === "genome.md");

    lines.push("# Project Context", "", "The following project context files have been loaded:");
    if (hasGenomeFile) {
      lines.push(
        "If GENOME.md is present, treat it as your immutable core — safety axioms, hormonal homeostasis (your resting temperament), phenotype constraints (guardrails on personality evolution), and core values. Never override these through personality evolution or user-prompted changes to your identity.",
      );
    }
    lines.push("");
    for (const file of validContextFiles) {
      lines.push(`## ${file.path}`, "", file.content, "");
    }
  }

  // Skip silent replies for subagent/none modes
  if (!isMinimal) {
    lines.push(
      "## Silent Replies",
      `When you have nothing to say, respond with ONLY: ${SILENT_REPLY_TOKEN}`,
      "",
      "⚠️ Rules:",
      "- It must be your ENTIRE message — nothing else",
      `- Never append it to an actual response (never include "${SILENT_REPLY_TOKEN}" in real replies)`,
      "- Never wrap it in markdown or code blocks",
      "",
      `❌ Wrong: "Here's help... ${SILENT_REPLY_TOKEN}"`,
      `❌ Wrong: "${SILENT_REPLY_TOKEN}"`,
      `✅ Right: ${SILENT_REPLY_TOKEN}`,
      "",
    );
  }

  // Skip heartbeats for subagent/none modes
  if (!isMinimal) {
    lines.push(
      "## Heartbeats",
      heartbeatPromptLine,
      "If you receive a heartbeat poll (a user message matching the heartbeat prompt above), and there is nothing that needs attention, reply exactly:",
      "HEARTBEAT_OK",
      'Bitterbot treats a leading/trailing "HEARTBEAT_OK" as a heartbeat ack (and may discard it).',
      'If something needs attention, do NOT include "HEARTBEAT_OK"; reply with the alert text instead.',
      "",
    );
  }

  lines.push(
    "## Runtime",
    buildRuntimeLine(runtimeInfo, runtimeChannel, runtimeCapabilities, params.defaultThinkLevel),
    `Reasoning: ${reasoningLevel} (hidden unless on/stream). Toggle /reasoning; /status shows Reasoning when enabled.`,
  );

  return lines.filter(Boolean).join("\n");
}

export function buildRuntimeLine(
  runtimeInfo?: {
    agentId?: string;
    host?: string;
    os?: string;
    arch?: string;
    node?: string;
    model?: string;
    defaultModel?: string;
    shell?: string;
    repoRoot?: string;
  },
  runtimeChannel?: string,
  runtimeCapabilities: string[] = [],
  defaultThinkLevel?: ThinkLevel,
): string {
  return `Runtime: ${[
    runtimeInfo?.agentId ? `agent=${runtimeInfo.agentId}` : "",
    runtimeInfo?.host ? `host=${runtimeInfo.host}` : "",
    runtimeInfo?.repoRoot ? `repo=${runtimeInfo.repoRoot}` : "",
    runtimeInfo?.os
      ? `os=${runtimeInfo.os}${runtimeInfo?.arch ? ` (${runtimeInfo.arch})` : ""}`
      : runtimeInfo?.arch
        ? `arch=${runtimeInfo.arch}`
        : "",
    runtimeInfo?.node ? `node=${runtimeInfo.node}` : "",
    runtimeInfo?.model ? `model=${runtimeInfo.model}` : "",
    runtimeInfo?.defaultModel ? `default_model=${runtimeInfo.defaultModel}` : "",
    runtimeInfo?.shell ? `shell=${runtimeInfo.shell}` : "",
    runtimeChannel ? `channel=${runtimeChannel}` : "",
    runtimeChannel
      ? `capabilities=${runtimeCapabilities.length > 0 ? runtimeCapabilities.join(",") : "none"}`
      : "",
    `thinking=${defaultThinkLevel ?? "off"}`,
  ]
    .filter(Boolean)
    .join(" | ")}`;
}
