import type { BitterbotConfig } from "../config/config.js";
import { applyAgentDefaultPrimaryModel } from "./model-default.js";

// PLAN-17 Phase 5: bump primary to opus-4-7; the previous 4-6 default
// joins the legacy migration set so existing configs auto-roll forward.
export const OPENCODE_ZEN_DEFAULT_MODEL = "opencode/claude-opus-4-7";
const LEGACY_OPENCODE_ZEN_DEFAULT_MODELS = new Set([
  "opencode/claude-opus-4-6",
  "opencode/claude-opus-4-5",
  "opencode-zen/claude-opus-4-5",
  "opencode-zen/claude-opus-4-6",
]);

export function applyOpencodeZenModelDefault(cfg: BitterbotConfig): {
  next: BitterbotConfig;
  changed: boolean;
} {
  return applyAgentDefaultPrimaryModel({
    cfg,
    model: OPENCODE_ZEN_DEFAULT_MODEL,
    legacyModels: LEGACY_OPENCODE_ZEN_DEFAULT_MODELS,
  });
}
