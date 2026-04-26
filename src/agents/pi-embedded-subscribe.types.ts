import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { ReasoningLevel, VerboseLevel } from "../auto-reply/thinking.js";
import type { BitterbotConfig } from "../config/types.bitterbot.js";
import type { HookRunner } from "../plugins/hooks.js";
import type { BlockReplyChunking } from "./pi-embedded-block-chunker.js";

export type ToolResultFormat = "markdown" | "plain";

export type SubscribeEmbeddedPiSessionParams = {
  session: AgentSession;
  runId: string;
  hookRunner?: HookRunner;
  verboseLevel?: VerboseLevel;
  reasoningMode?: ReasoningLevel;
  toolResultFormat?: ToolResultFormat;
  shouldEmitToolResult?: () => boolean;
  shouldEmitToolOutput?: () => boolean;
  onToolResult?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onReasoningStream?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onBlockReply?: (payload: {
    text?: string;
    mediaUrls?: string[];
    audioAsVoice?: boolean;
    replyToId?: string;
    replyToTag?: boolean;
    replyToCurrent?: boolean;
  }) => void | Promise<void>;
  /** Flush pending block replies (e.g., before tool execution to preserve message boundaries). */
  onBlockReplyFlush?: () => void | Promise<void>;
  blockReplyBreak?: "text_end" | "message_end";
  blockReplyChunking?: BlockReplyChunking;
  onPartialReply?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onAssistantMessageStart?: () => void | Promise<void>;
  onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void | Promise<void>;
  enforceFinalTag?: boolean;
  config?: BitterbotConfig;
  sessionKey?: string;
  /**
   * Model context window in tokens. When provided, enables the mid-turn
   * budget guard that proactively compresses session messages between
   * tool calls so long tool loops don't overflow context.
   */
  contextWindowTokens?: number;
};

export type { BlockReplyChunking } from "./pi-embedded-block-chunker.js";
