import path from "node:path";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";

export { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";

// Compatibility helpers for pi-coding-agent 0.50+ (discover* helpers removed).
export function discoverAuthStorage(agentDir: string): AuthStorage {
  return AuthStorage.create(path.join(agentDir, "auth.json"));
}

export function discoverModels(authStorage: AuthStorage, agentDir: string): ModelRegistry {
  return ModelRegistry.create(authStorage, path.join(agentDir, "models.json"));
}
