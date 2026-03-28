import type { BitterbotConfig } from "../config/config.js";

export function applyOnboardingLocalWorkspaceConfig(
  baseConfig: BitterbotConfig,
  workspaceDir: string,
): BitterbotConfig {
  return {
    ...baseConfig,
    agents: {
      ...baseConfig.agents,
      defaults: {
        ...baseConfig.agents?.defaults,
        workspace: workspaceDir,
      },
    },
    gateway: {
      ...baseConfig.gateway,
      mode: "local",
    },
  };
}
