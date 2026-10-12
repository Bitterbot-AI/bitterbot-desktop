/**
 * Owned model registry and credential storage (PLAN-52 Phase 5).
 *
 * Ported from pi-coding-agent 0.73.1 (MIT, Mario Zechner / pi-mono). See the
 * headers of `auth-storage.ts`, `model-registry.ts`, `models-json-schema.ts`
 * and `resolve-config-value.ts` for what each file ports, every difference
 * from the original, and what is deliberately not ported.
 *
 * `discoverAuthStorage` and `discoverModels` open `<agentDir>/auth.json` and
 * `<agentDir>/models.json`; `auth-json.ts` bridges OAuth profiles into the
 * former.
 */

import path from "node:path";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";

export {
  type ApiKeyCredential,
  type AuthCredential,
  AuthStorage,
  type AuthStorageBackend,
  type AuthStorageData,
  FileAuthStorageBackend,
  InMemoryAuthStorageBackend,
  type OAuthCredential,
} from "./auth-storage.js";
export {
  clearApiKeyCache,
  ModelRegistry,
  type ProviderConfigInput,
  type ResolvedRequestAuth,
} from "./model-registry.js";

export function discoverAuthStorage(agentDir: string): AuthStorage {
  return AuthStorage.create(path.join(agentDir, "auth.json"));
}

export function discoverModels(authStorage: AuthStorage, agentDir: string): ModelRegistry {
  return ModelRegistry.create(authStorage, path.join(agentDir, "models.json"));
}
