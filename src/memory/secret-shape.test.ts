/** PLAN-55 Phase 1 review (item 5): credential shapes never become facts. */
import { describe, expect, it } from "vitest";
import {
  looksLikeSecretKey,
  looksLikeSecretValue,
  redactSecretShapes,
  secretRejectionReason,
} from "./secret-shape.js";

describe("secret-shape", () => {
  it.each([
    "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    "github_pat_11ABCDEFG0123456789abcdefghij",
    "sk-proj-abcdefghijklmnop",
    "sk-ant-api03-abcdefghijklmnop",
    "sk_live_abcdefghijklmnop",
    "xoxb-123456789012-abcdefghijkl",
    "xapp-1-abcdefghijklmn",
    "AKIAABCDEFGHIJKLMNOP",
    "AIzaSyAbcdefghijklmnopqrstuvwxyz1234",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIE...",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdefghijk123",
    "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "Bearer abcdefghijklmnopqrstuvwxyz",
    "API_KEY=abcdef123456",
    "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789",
    "aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5zA7bC9dE1fG3hI5jK7",
  ])("flags: %s", (value) => {
    expect(looksLikeSecretValue(value)).toBe(true);
  });

  it.each([
    "api2.acme.com",
    "github.com/Bitterbot-AI/bitterbot-desktop",
    "Victor",
    "Europe/Madrid",
    "v1.4.0-rc.2",
    "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "the deploy endpoint for acme reports is the client timezone one",
    "+34 600 000 000",
    "sk8er boi",
  ])("passes: %s", (value) => {
    expect(looksLikeSecretValue(value)).toBe(false);
  });

  it("flags keys that name a credential, and never echoes the value in the reason", () => {
    for (const key of [
      "identity.github.token",
      "infra.api_key",
      "infra.apikey",
      "infra.db.password",
      "identity.ssn",
      "infra.private_key",
      "preference.credentials",
    ]) {
      expect(looksLikeSecretKey(key)).toBe(true);
    }
    for (const key of ["infra.deploy_endpoint", "identity.user.name", "project.tokenizer"]) {
      expect(looksLikeSecretKey(key)).toBe(false);
    }
    const reason = secretRejectionReason(
      "infra.github.handle",
      "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    )!;
    expect(reason).toMatch(/credential/);
    expect(reason).not.toContain("ghp_");
    expect(secretRejectionReason("infra.deploy_endpoint", "api2.acme.com")).toBeNull();
  });
});

describe("redactSecretShapes (PLAN-55 Phase 3 export)", () => {
  it("replaces the secret and keeps the words around it", () => {
    const out = redactSecretShapes("my token is ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789, thanks");
    expect(out.text).toBe("my token is [redacted], thanks");
    expect(out.redactions).toBe(1);
  });

  it("keeps the name of an assignment and drops its value", () => {
    const out = redactSecretShapes("OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuv");
    expect(out.text).toContain("OPENAI_API_KEY=");
    expect(out.text).not.toContain("abcdefghijklmnopqrstuv");
  });

  it("removes private key blocks and JWTs, and leaves plain text alone", () => {
    const pem =
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----";
    expect(redactSecretShapes(pem).text).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC");
    expect(
      redactSecretShapes(
        "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
      ).text,
    ).toBe("jwt [redacted]");
    expect(redactSecretShapes("Victor lives in Lisbon.")).toEqual({
      text: "Victor lives in Lisbon.",
      redactions: 0,
    });
  });
});
