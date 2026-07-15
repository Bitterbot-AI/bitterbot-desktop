import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPair, pubkeyId } from "../../commerce/envelope.js";
import { startMailboxHost, type MailboxHostHandle } from "./mailbox-host.js";
import { blobDigest, buildMailboxProof } from "./mailbox.js";

// PLAN-36 Phase 1: the standalone mailbox host, exercised over real HTTP
// (post -> poll -> ack round-trip), so we know a deployed host actually serves
// the client's sealed store-and-forward path — not just the in-process handler.

describe("standalone mailbox host (HTTP)", () => {
  let host: MailboxHostHandle | undefined;
  const sender = generateKeyPair();
  const recipient = generateKeyPair();

  afterEach(async () => {
    await host?.close();
    host = undefined;
  });

  async function rpc(base: string, method: string, params: unknown) {
    const res = await fetch(`${base}/a2a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "1", method, params }),
    });
    return {
      status: res.status,
      body: (await res.json()) as { result?: unknown; error?: unknown },
    };
  }

  it("serves a sealed blob only to its recipient, and drains on ack", async () => {
    host = await startMailboxHost({ port: 0, host: "127.0.0.1" });
    const base = `http://127.0.0.1:${host.port}`;
    const to = pubkeyId(recipient);
    const blob = `{"sealed":"ciphertext-the-host-cannot-read"}`;

    // Health check.
    const health = await fetch(`${base}/`);
    expect(health.status).toBe(200);

    // A non-mailbox method is refused (this host serves mailbox/* only).
    const nope = await rpc(base, "circle/message", {});
    expect(nope.status).toBe(404);

    // Post (signed by the sender, bound to the recipient + blob).
    const now = Date.now();
    const postProof = buildMailboxProof({
      verb: "post",
      pubkey: pubkeyId(sender),
      privateKey: sender.privateKey,
      extra: blobDigest(to, blob),
      now,
    });
    const posted = await rpc(base, "mailbox/post", { to, blob, proof: postProof });
    expect(posted.status).toBe(200);
    expect((posted.body.result as { blobId: string }).blobId).toBeTruthy();

    // The recipient polls and gets exactly their blob back.
    const pollProof = buildMailboxProof({
      verb: "poll",
      pubkey: to,
      privateKey: recipient.privateKey,
      extra: "0",
      now: Date.now(),
    });
    const polled = await rpc(base, "mailbox/poll", { proof: pollProof, since: 0 });
    const blobs = (polled.body.result as { blobs: Array<{ blob: string; blobId: string }> }).blobs;
    expect(blobs).toHaveLength(1);
    expect(blobs[0]?.blob).toBe(blob);
    const blobId = blobs[0]!.blobId;

    // A stranger polling gets an empty box, never the recipient's mail.
    const eve = generateKeyPair();
    const eveProof = buildMailboxProof({
      verb: "poll",
      pubkey: pubkeyId(eve),
      privateKey: eve.privateKey,
      extra: "0",
      now: Date.now(),
    });
    const evePolled = await rpc(base, "mailbox/poll", { proof: eveProof, since: 0 });
    expect((evePolled.body.result as { blobs: unknown[] }).blobs).toHaveLength(0);

    // Ack drains it; a second poll is empty.
    const ackProof = buildMailboxProof({
      verb: "ack",
      pubkey: to,
      privateKey: recipient.privateKey,
      extra: blobId,
      now: Date.now(),
    });
    const acked = await rpc(base, "mailbox/ack", { proof: ackProof, blobIds: [blobId] });
    expect((acked.body.result as { deleted: number }).deleted).toBe(1);

    const pollProof2 = buildMailboxProof({
      verb: "poll",
      pubkey: to,
      privateKey: recipient.privateKey,
      extra: "0",
      now: Date.now(),
    });
    const drained = await rpc(base, "mailbox/poll", { proof: pollProof2, since: 0 });
    expect((drained.body.result as { blobs: unknown[] }).blobs).toHaveLength(0);
  });
});
