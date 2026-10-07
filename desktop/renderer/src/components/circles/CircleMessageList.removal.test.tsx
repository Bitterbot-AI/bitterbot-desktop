import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CircleMember, CircleMessage } from "../../stores/circles-store";
import { CircleMessageList } from "./CircleMessageList";

// Security pass M2: a friend's removal notice is the nudge; the one-tap
// "remove on my node too" is what completes the removal here (and rotates
// this node's sender key server-side). Two taps, and only while the named
// member is still on our roster.

const member = (memberPubkey: string, displayName: string, isSelf = false): CircleMember =>
  ({
    memberPubkey,
    displayName,
    role: "member",
    isSelf,
    lastSeenAt: null,
    lastStatus: null,
  }) as CircleMember;

const notice = (systemTarget: string): CircleMessage => ({
  messageId: "m1",
  envelopeId: "e1",
  authorPubkey: "ed25519:alice",
  direction: "in",
  kind: "system",
  content: "Removed member ed25519:mallory… from my copy of this circle.",
  createdAt: Date.now(),
  systemTarget,
});

describe("removal notice follow-through", () => {
  it("confirms, then removes the named member on this node", async () => {
    const onRemoveMember = vi.fn();
    render(
      <CircleMessageList
        messages={[notice("ed25519:mallory")]}
        members={[
          member("ed25519:self", "Me", true),
          member("ed25519:alice", "Alice"),
          member("ed25519:mallory", "Mallory"),
        ]}
        selfPubkey="ed25519:self"
        onReply={() => {}}
        onRemoveMember={onRemoveMember}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /remove on my node too/i }));
    expect(onRemoveMember).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /remove mallory on my node/i }));
    expect(onRemoveMember).toHaveBeenCalledWith("ed25519:mallory");
  });

  it("offers nothing once the member is already off our roster", () => {
    render(
      <CircleMessageList
        messages={[notice("ed25519:mallory")]}
        members={[member("ed25519:self", "Me", true), member("ed25519:alice", "Alice")]}
        selfPubkey="ed25519:self"
        onReply={() => {}}
        onRemoveMember={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /remove on my node/i })).toBeNull();
  });
});
