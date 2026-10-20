export {
  buildBootstrapContextFiles,
  DEFAULT_BOOTSTRAP_MAX_CHARS,
  DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS,
  ensureSessionHeader,
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
  stripThoughtSignatures,
} from "./embedded-helpers/bootstrap.js";
export {
  BILLING_ERROR_USER_MESSAGE,
  formatBillingErrorMessage,
  classifyFailoverReason,
  formatRawAssistantErrorForUi,
  formatAssistantErrorText,
  getApiErrorPayloadFingerprint,
  isAuthAssistantError,
  isAuthErrorMessage,
  isBillingAssistantError,
  parseApiErrorInfo,
  sanitizeUserFacingText,
  isBillingErrorMessage,
  isCloudflareOrHtmlErrorPage,
  isCloudCodeAssistFormatError,
  isCompactionFailureError,
  isContextOverflowError,
  isLikelyContextOverflowError,
  isFailoverAssistantError,
  isFailoverErrorMessage,
  isImageDimensionErrorMessage,
  isImageSizeError,
  isOverloadedErrorMessage,
  isRawApiErrorPayload,
  isRateLimitAssistantError,
  isRateLimitErrorMessage,
  isTransientHttpError,
  isTimeoutErrorMessage,
  parseImageDimensionError,
  parseImageSizeError,
} from "./embedded-helpers/errors.js";
export { isGoogleModelApi, sanitizeGoogleTurnOrdering } from "./embedded-helpers/google.js";

export { downgradeOpenAIReasoningBlocks } from "./embedded-helpers/openai.js";
export {
  isEmptyAssistantMessageContent,
  sanitizeSessionMessagesImages,
} from "./embedded-helpers/images.js";
export {
  isMessagingToolDuplicate,
  isMessagingToolDuplicateNormalized,
  normalizeTextForComparison,
} from "./embedded-helpers/messaging-dedupe.js";

export { pickFallbackThinkingLevel } from "./embedded-helpers/thinking.js";

export {
  mergeConsecutiveUserTurns,
  validateAnthropicTurns,
  validateGeminiTurns,
} from "./embedded-helpers/turns.js";
export type { EmbeddedContextFile, FailoverReason } from "./embedded-helpers/types.js";

export type { ToolCallIdMode } from "./tool-call-id.js";
export { isValidCloudCodeAssistToolId, sanitizeToolCallId } from "./tool-call-id.js";
