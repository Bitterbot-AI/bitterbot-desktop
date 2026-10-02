/**
 * Credential storage for API keys and OAuth tokens (auth.json).
 *
 * Ported from pi-coding-agent 0.73.1 (MIT, Mario Zechner / pi-mono):
 * `src/core/auth-storage.ts`.
 *
 * What is ported: `FileAuthStorageBackend` and `InMemoryAuthStorageBackend`
 * (same locking, same retry numbers, same re-read under the lock), and
 * `AuthStorage` with `create`, `fromStorage`, `inMemory`, `setRuntimeApiKey`,
 * `removeRuntimeApiKey`, `setFallbackResolver`, `reload`, `get`, `set`,
 * `remove`, `list`, `has`, `hasAuth`, `getAll`, `drainErrors`, `getApiKey`
 * and `getOAuthProviders`.
 *
 * Kept exactly:
 * - The file format: `JSON.stringify(data, null, 2)` with no trailing
 *   newline; a missing file is created as `{}`.
 * - File modes: the parent directory is created with 0o700, auth.json is
 *   chmod 0o600 after creation and after every write.
 * - `getApiKey` precedence: runtime override, stored api_key credential,
 *   stored OAuth credential (refreshed under the file lock when expired),
 *   environment variable (pi-ai `getEnvApiKey`), fallback resolver.
 * - OAuth refresh: the lock is taken, the file is re-read, and the refresh is
 *   skipped when another process already stored an unexpired token. The
 *   refresh itself is pi-ai's `getOAuthApiKey`.
 *
 * Differences from the original:
 * - `AuthStorage.create(authPath)` and `new FileAuthStorageBackend(authPath)`
 *   require the path. pi defaults to `~/.pi/agent/auth.json` (or
 *   `$PI_CODING_AGENT_DIR`); this repo always passes its own agent dir, and a
 *   silent default into pi's directory would be wrong here.
 * - `proper-lockfile` is typed through a local interface, because the repo's
 *   ambient declaration (`src/types/proper-lockfile.d.ts`) does not declare
 *   `lockSync` or `onCompromised`. The calls are the same.
 *
 * Not ported (reached only from pi's interactive TUI): `login`, `logout`,
 * `getAuthStatus`.
 *
 * pi quirks kept:
 * - A stored api_key value goes through `resolveConfigValue`: it may be a
 *   literal, the NAME of an environment variable, or a "!command".
 * - An empty runtime override ("") is ignored by `getApiKey` but counts as
 *   auth for `hasAuth`.
 * - A stored OAuth credential whose provider id is unknown yields no key and
 *   does NOT fall through to the environment variable. A failed refresh also
 *   yields no key. An expired credential that is no longer an OAuth entry
 *   when the file is re-read under the lock does fall through to the
 *   environment variable and the fallback resolver (and the call does not
 *   return a key that replaced it on disk; the next call does).
 * - A stored api_key credential that resolves to nothing (failed command)
 *   returns undefined without falling through.
 * - If auth.json cannot be parsed at load, the error is recorded, `set` and
 *   `remove` update memory only and never write the file (so a corrupt file
 *   is not overwritten), until a later `reload()` succeeds.
 * - `reload()` takes the file lock, creating the directory and an empty
 *   auth.json as a side effect of merely constructing the storage.
 * - The synchronous lock retry is a busy wait (10 attempts, 20 ms apart).
 *   If another process holds the lock for longer than that (for example
 *   during an OAuth refresh, which holds it across a network call), a
 *   `reload()` or constructor load fails: a new instance then has no stored
 *   credentials at all and, as above, stops persisting until a later
 *   `reload()` succeeds. Nothing is thrown; the error is only in
 *   `drainErrors()`.
 *
 * Security: no key, token or file content is logged here. Errors are kept in
 * memory and handed out by `drainErrors()`; a JSON parse error from a corrupt
 * auth.json can quote a few characters of the file in its message (the
 * engine's SyntaxError text), which a caller that logs drained errors should
 * keep in mind.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getEnvApiKey, type OAuthCredentials, type OAuthProviderId } from "@mariozechner/pi-ai";
import { getOAuthApiKey, getOAuthProvider, getOAuthProviders } from "@mariozechner/pi-ai/oauth";
import lockfileModule from "proper-lockfile";
import { resolveConfigValue } from "./resolve-config-value.js";

export type ApiKeyCredential = {
  type: "api_key";
  key: string;
};

export type OAuthCredential = {
  type: "oauth";
} & OAuthCredentials;

export type AuthCredential = ApiKeyCredential | OAuthCredential;

export type AuthStorageData = Record<string, AuthCredential>;

type LockResult<T> = {
  result: T;
  next?: string;
};

export interface AuthStorageBackend {
  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
  withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
}

/** The part of proper-lockfile used here (see the header for why it is local). */
type ProperLockfile = {
  lockSync(path: string, options?: { realpath?: boolean }): () => void;
  lock(
    path: string,
    options?: {
      retries?: {
        retries?: number;
        factor?: number;
        minTimeout?: number;
        maxTimeout?: number;
        randomize?: boolean;
      };
      stale?: number;
      onCompromised?: (err: Error) => void;
    },
  ): Promise<() => Promise<void>>;
};

const lockfile = lockfileModule as unknown as ProperLockfile;

export class FileAuthStorageBackend implements AuthStorageBackend {
  constructor(private authPath: string) {}

  private ensureParentDir(): void {
    const dir = dirname(this.authPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  private ensureFileExists(): void {
    if (!existsSync(this.authPath)) {
      writeFileSync(this.authPath, "{}", "utf-8");
      chmodSync(this.authPath, 0o600);
    }
  }

  private acquireLockSyncWithRetry(path: string): () => void {
    const maxAttempts = 10;
    const delayMs = 20;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return lockfile.lockSync(path, { realpath: false });
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String((error as { code?: unknown }).code)
            : undefined;
        if (code !== "ELOCKED" || attempt === maxAttempts) {
          throw error;
        }
        lastError = error;
        const start = Date.now();
        while (Date.now() - start < delayMs) {
          // Sleep synchronously to avoid changing callers to async.
        }
      }
    }

    throw (lastError as Error) ?? new Error("Failed to acquire auth storage lock");
  }

  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
    this.ensureParentDir();
    this.ensureFileExists();

    let release: (() => void) | undefined;
    try {
      release = this.acquireLockSyncWithRetry(this.authPath);
      const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
      const { result, next } = fn(current);
      if (next !== undefined) {
        writeFileSync(this.authPath, next, "utf-8");
        chmodSync(this.authPath, 0o600);
      }
      return result;
    } finally {
      if (release) {
        release();
      }
    }
  }

  async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
    this.ensureParentDir();
    this.ensureFileExists();

    let release: (() => Promise<void>) | undefined;
    let lockCompromised = false;
    let lockCompromisedError: Error | undefined;
    const throwIfCompromised = () => {
      if (lockCompromised) {
        throw lockCompromisedError ?? new Error("Auth storage lock was compromised");
      }
    };

    try {
      release = await lockfile.lock(this.authPath, {
        retries: {
          retries: 10,
          factor: 2,
          minTimeout: 100,
          maxTimeout: 10000,
          randomize: true,
        },
        stale: 30000,
        onCompromised: (err) => {
          lockCompromised = true;
          lockCompromisedError = err;
        },
      });

      throwIfCompromised();
      const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
      const { result, next } = await fn(current);
      throwIfCompromised();
      if (next !== undefined) {
        writeFileSync(this.authPath, next, "utf-8");
        chmodSync(this.authPath, 0o600);
      }
      throwIfCompromised();
      return result;
    } finally {
      if (release) {
        try {
          await release();
        } catch {
          // Ignore unlock errors when lock is compromised.
        }
      }
    }
  }
}

export class InMemoryAuthStorageBackend implements AuthStorageBackend {
  private value: string | undefined;

  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
    const { result, next } = fn(this.value);
    if (next !== undefined) {
      this.value = next;
    }
    return result;
  }

  async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
    const { result, next } = await fn(this.value);
    if (next !== undefined) {
      this.value = next;
    }
    return result;
  }
}

/**
 * Credential storage backed by a JSON file.
 */
export class AuthStorage {
  private data: AuthStorageData = {};
  private runtimeOverrides: Map<string, string> = new Map();
  private fallbackResolver?: (provider: string) => string | undefined;
  private loadError: Error | null = null;
  private errors: Error[] = [];

  private constructor(private storage: AuthStorageBackend) {
    this.reload();
  }

  static create(authPath: string): AuthStorage {
    return new AuthStorage(new FileAuthStorageBackend(authPath));
  }

  static fromStorage(storage: AuthStorageBackend): AuthStorage {
    return new AuthStorage(storage);
  }

  static inMemory(data: AuthStorageData = {}): AuthStorage {
    const storage = new InMemoryAuthStorageBackend();
    storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
    return AuthStorage.fromStorage(storage);
  }

  /**
   * Set a runtime API key override (not persisted to disk).
   */
  setRuntimeApiKey(provider: string, apiKey: string): void {
    this.runtimeOverrides.set(provider, apiKey);
  }

  /**
   * Remove a runtime API key override.
   */
  removeRuntimeApiKey(provider: string): void {
    this.runtimeOverrides.delete(provider);
  }

  /**
   * Set a fallback resolver for API keys not found in auth.json or env vars.
   */
  setFallbackResolver(resolver: (provider: string) => string | undefined): void {
    this.fallbackResolver = resolver;
  }

  private recordError(error: unknown): void {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    this.errors.push(normalizedError);
  }

  private parseStorageData(content: string | undefined): AuthStorageData {
    if (!content) {
      return {};
    }
    return JSON.parse(content) as AuthStorageData;
  }

  /**
   * Reload credentials from storage.
   */
  reload(): void {
    let content: string | undefined;
    try {
      this.storage.withLock((current) => {
        content = current;
        return { result: undefined };
      });
      this.data = this.parseStorageData(content);
      this.loadError = null;
    } catch (error) {
      this.loadError = error as Error;
      this.recordError(error);
    }
  }

  private persistProviderChange(provider: string, credential: AuthCredential | undefined): void {
    if (this.loadError) {
      return;
    }

    try {
      this.storage.withLock((current) => {
        const currentData = this.parseStorageData(current);
        const merged: AuthStorageData = { ...currentData };
        if (credential) {
          merged[provider] = credential;
        } else {
          delete merged[provider];
        }
        return { result: undefined, next: JSON.stringify(merged, null, 2) };
      });
    } catch (error) {
      this.recordError(error);
    }
  }

  /**
   * Get credential for a provider.
   */
  get(provider: string): AuthCredential | undefined {
    return this.data[provider] ?? undefined;
  }

  /**
   * Set credential for a provider.
   */
  set(provider: string, credential: AuthCredential): void {
    this.data[provider] = credential;
    this.persistProviderChange(provider, credential);
  }

  /**
   * Remove credential for a provider.
   */
  remove(provider: string): void {
    delete this.data[provider];
    this.persistProviderChange(provider, undefined);
  }

  /**
   * List all providers with credentials.
   */
  list(): string[] {
    return Object.keys(this.data);
  }

  /**
   * Check if credentials exist for a provider in auth.json.
   */
  has(provider: string): boolean {
    return provider in this.data;
  }

  /**
   * Check if any form of auth is configured for a provider.
   * Unlike getApiKey(), this doesn't refresh OAuth tokens.
   */
  hasAuth(provider: string): boolean {
    if (this.runtimeOverrides.has(provider)) {
      return true;
    }
    if (this.data[provider]) {
      return true;
    }
    if (getEnvApiKey(provider)) {
      return true;
    }
    if (this.fallbackResolver?.(provider)) {
      return true;
    }
    return false;
  }

  /**
   * Get all credentials (a shallow copy).
   */
  getAll(): AuthStorageData {
    return { ...this.data };
  }

  drainErrors(): Error[] {
    const drained = [...this.errors];
    this.errors = [];
    return drained;
  }

  /**
   * Refresh OAuth token with backend locking to prevent race conditions.
   * Several processes may try to refresh at once when a token expires.
   */
  private async refreshOAuthTokenWithLock(
    providerId: OAuthProviderId,
  ): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
    const provider = getOAuthProvider(providerId);
    if (!provider) {
      return null;
    }

    const result = await this.storage.withLockAsync(async (current) => {
      const currentData = this.parseStorageData(current);
      this.data = currentData;
      this.loadError = null;

      const cred = currentData[providerId];
      if (cred?.type !== "oauth") {
        return { result: null };
      }

      if (Date.now() < cred.expires) {
        return { result: { apiKey: provider.getApiKey(cred), newCredentials: cred } };
      }

      const oauthCreds: Record<string, OAuthCredentials> = {};
      for (const [key, value] of Object.entries(currentData)) {
        if (value.type === "oauth") {
          oauthCreds[key] = value;
        }
      }

      const refreshed = await getOAuthApiKey(providerId, oauthCreds);
      if (!refreshed) {
        return { result: null };
      }

      const merged: AuthStorageData = {
        ...currentData,
        [providerId]: { type: "oauth", ...refreshed.newCredentials },
      };
      this.data = merged;
      this.loadError = null;
      return { result: refreshed, next: JSON.stringify(merged, null, 2) };
    });

    return result;
  }

  /**
   * Get API key for a provider.
   * Priority:
   * 1. Runtime override
   * 2. API key from auth.json
   * 3. OAuth token from auth.json (auto-refreshed with locking)
   * 4. Environment variable
   * 5. Fallback resolver
   */
  async getApiKey(
    providerId: string,
    options?: { includeFallback?: boolean },
  ): Promise<string | undefined> {
    // Runtime override takes highest priority.
    const runtimeKey = this.runtimeOverrides.get(providerId);
    if (runtimeKey) {
      return runtimeKey;
    }

    const cred = this.data[providerId];

    if (cred?.type === "api_key") {
      return resolveConfigValue(cred.key);
    }

    if (cred?.type === "oauth") {
      const provider = getOAuthProvider(providerId);
      if (!provider) {
        // Unknown OAuth provider, can't get API key.
        return undefined;
      }

      // Check if token needs refresh.
      const needsRefresh = Date.now() >= cred.expires;

      if (needsRefresh) {
        // Use locked refresh to prevent race conditions.
        try {
          const result = await this.refreshOAuthTokenWithLock(providerId);
          if (result) {
            return result.apiKey;
          }
        } catch (error) {
          this.recordError(error);
          // Refresh failed: re-read the file to check if another process succeeded.
          this.reload();
          const updatedCred = this.data[providerId];

          if (updatedCred?.type === "oauth" && Date.now() < updatedCred.expires) {
            // Another process refreshed successfully, use those credentials.
            return provider.getApiKey(updatedCred);
          }

          // Refresh truly failed: return undefined so model discovery skips this
          // provider. The stored credentials are preserved for a retry.
          return undefined;
        }
      } else {
        // Token not expired, use current access token.
        return provider.getApiKey(cred);
      }
    }

    // Fall back to environment variable.
    const envKey = getEnvApiKey(providerId);
    if (envKey) {
      return envKey;
    }

    // Fall back to custom resolver.
    if (options?.includeFallback !== false) {
      return this.fallbackResolver?.(providerId) ?? undefined;
    }

    return undefined;
  }

  /**
   * Get all registered OAuth providers.
   */
  getOAuthProviders() {
    return getOAuthProviders();
  }
}
