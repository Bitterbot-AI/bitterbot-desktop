import { describe, expect, it } from "vitest";
import { computeNameFlags, type NameFlagInput } from "./petnames.js";

// §5.6 review F1/F2: the collision cue must catch an impostor copying a
// friend's display name EVEN when you've petnamed that friend, and must NOT
// alarm on the friend you've identified.

const SELF = "ed25519:" + "0".repeat(64);
const REAL = "ed25519:" + "a".repeat(64); // your real friend Maya
const IMP = "ed25519:" + "b".repeat(64); // an impostor copying "Maya"
const OTHER = "ed25519:" + "c".repeat(64);

function member(pubkey: string, displayName: string | null, isSelf = false): NameFlagInput {
  return { memberPubkey: pubkey, displayName, isSelf };
}

describe("computeNameFlags", () => {
  it("flags an impostor copying a friend's display name even after you petnamed the friend (F1)", () => {
    const flags = computeNameFlags(
      [member(SELF, "Me", true), member(REAL, "Maya"), member(IMP, "Maya")],
      { [REAL]: "Roomie" }, // you petnamed the real Maya "Roomie"
    );
    // The impostor is flagged — the cue keys on the spoofable displayName.
    expect(flags.get(IMP)).toEqual({ unverified: true, nameCollision: true });
    // Your identified friend carries NO badge (F2 — petnamed = suppressed).
    expect(flags.get(REAL)).toEqual({ unverified: false, nameCollision: false });
  });

  it("flags an impostor self-asserting a name you privately gave to someone else", () => {
    const flags = computeNameFlags(
      [member(SELF, "Me", true), member(REAL, "M"), member(IMP, "Roomie")],
      {
        [REAL]: "Roomie", // you call REAL "Roomie"; IMP now self-asserts "Roomie"
      },
    );
    expect(flags.get(IMP)?.nameCollision).toBe(true);
    expect(flags.get(REAL)?.nameCollision).toBe(false); // identified, suppressed
  });

  it("flags BOTH when two un-petnamed peers share a self-asserted name (genuine ambiguity)", () => {
    const flags = computeNameFlags(
      [member(SELF, "Me", true), member(REAL, "Maya"), member(IMP, "Maya")],
      {},
    );
    expect(flags.get(REAL)?.nameCollision).toBe(true);
    expect(flags.get(IMP)?.nameCollision).toBe(true);
  });

  it("no collision for distinct names; unverified until petnamed", () => {
    const flags = computeNameFlags(
      [member(SELF, "Me", true), member(REAL, "Maya"), member(OTHER, "Ben")],
      {},
    );
    expect(flags.get(REAL)).toEqual({ unverified: true, nameCollision: false });
    expect(flags.get(OTHER)).toEqual({ unverified: true, nameCollision: false });
    // Petnaming clears unverified.
    const named = computeNameFlags([member(SELF, "Me", true), member(REAL, "Maya")], {
      [REAL]: "Maya from lab",
    });
    expect(named.get(REAL)).toEqual({ unverified: false, nameCollision: false });
  });

  it("dedupes a pubkey appearing in multiple circles; ignores empty names and self", () => {
    const flags = computeNameFlags(
      [
        member(SELF, "Me", true),
        member(REAL, "Maya"),
        member(REAL, "Maya"), // same person, another circle
        member(OTHER, null), // no self-asserted name
      ],
      {},
    );
    expect(flags.size).toBe(2); // REAL + OTHER, self excluded, dedup
    expect(flags.get(REAL)?.nameCollision).toBe(false); // not a collision with itself
    expect(flags.get(OTHER)).toEqual({ unverified: true, nameCollision: false });
  });
});
