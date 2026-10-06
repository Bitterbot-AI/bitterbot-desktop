/**
 * Signing in to an MCP server that uses OAuth (PLAN-53 D3).
 *
 * The MCP SDK runs the flow (discovery, client registration, PKCE, token
 * refresh); this provider is where its state lives: one 0600 file per
 * server. The owner signs in in their own browser and is sent back to the
 * gateway's /mcp/oauth/callback, which finishes the exchange.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

type Saved = {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
};

export function oauthFile(stateDir: string, server: string): string {
  return path.join(stateDir, "mcp", "oauth", `${server}.json`);
}

export class FileOAuthProvider implements OAuthClientProvider {
  /** Set when the server asked for a sign-in; the owner opens it. */
  pendingAuthorizationUrl: string | null = null;

  constructor(
    private readonly file: string,
    private readonly callbackUrl: string,
  ) {}

  private read(): Saved {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8")) as Saved;
    } catch {
      return {};
    }
  }

  private write(patch: Partial<Saved>): void {
    const next = { ...this.read(), ...patch };
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get redirectUrl(): string {
    return this.callbackUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Bitterbot",
      redirect_uris: [this.callbackUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  /** A fresh value per sign-in; the callback must bring it back. */
  state(): string {
    const state = crypto.randomBytes(24).toString("base64url");
    this.write({ state });
    return state;
  }

  savedState(): string | undefined {
    return this.read().state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.read().clientInformation;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.write({ clientInformation: info });
  }

  tokens(): OAuthTokens | undefined {
    return this.read().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    // A finished sign-in: the state is spent.
    this.write({ tokens, state: undefined });
  }

  redirectToAuthorization(url: URL): void {
    this.pendingAuthorizationUrl = url.toString();
  }

  saveCodeVerifier(verifier: string): void {
    this.write({ codeVerifier: verifier });
  }

  codeVerifier(): string {
    const verifier = this.read().codeVerifier;
    if (!verifier) {
      throw new Error("no sign-in is in progress for this connector");
    }
    return verifier;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    const saved = this.read();
    if (scope === "all") {
      fs.rmSync(this.file, { force: true });
      return;
    }
    if (scope === "client") delete saved.clientInformation;
    if (scope === "tokens") delete saved.tokens;
    if (scope === "verifier") delete saved.codeVerifier;
    this.write(saved);
  }

  signedIn(): boolean {
    return Boolean(this.read().tokens?.access_token);
  }

  signOut(): void {
    fs.rmSync(this.file, { force: true });
    this.pendingAuthorizationUrl = null;
  }
}

/** Constant-time comparison of the callback's state with the one we issued. */
export function stateMatches(expected: string | undefined, got: string | null): boolean {
  if (!expected || !got) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
