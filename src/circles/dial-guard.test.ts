import { describe, expect, it } from "vitest";
import { publicDialUrlError } from "./dial-guard.js";

// PLAN-36 §4 follow-up (b): every URL circleRpc dials is peer-supplied, so
// the guard must refuse anything that would let a hostile peer aim this
// node's HTTP client at loopback, the LAN, or cloud metadata.

describe("publicDialUrlError", () => {
  it("accepts ordinary public https/http targets", () => {
    expect(publicDialUrlError("https://mailbox.bitterbot.ai")).toBeNull();
    expect(publicDialUrlError("https://a2a.bitterbot.ai/a2a")).toBeNull();
    expect(publicDialUrlError("http://93.184.216.34:8080")).toBeNull();
    // Mesh-test fixtures ("https://ana.test") are syntactically public.
    expect(publicDialUrlError("https://ana.test")).toBeNull();
  });

  it("refuses garbage and non-http schemes", () => {
    expect(publicDialUrlError("not a url")).toMatch(/not a valid URL/);
    expect(publicDialUrlError("file:///etc/passwd")).toMatch(/scheme/);
    expect(publicDialUrlError("ftp://example.com")).toMatch(/scheme/);
    expect(publicDialUrlError("gopher://example.com")).toMatch(/scheme/);
  });

  it("refuses credentials in the URL", () => {
    expect(publicDialUrlError("https://user:pass@example.com")).toMatch(/credentials/);
  });

  it("refuses loopback and internal hostnames", () => {
    expect(publicDialUrlError("http://localhost:19001")).toMatch(/not a public dial target/);
    expect(publicDialUrlError("http://foo.localhost")).toMatch(/not a public dial target/);
    expect(publicDialUrlError("http://gateway.local")).toMatch(/not a public dial target/);
    expect(publicDialUrlError("http://db.internal")).toMatch(/not a public dial target/);
    expect(publicDialUrlError("http://router.home.arpa")).toMatch(/not a public dial target/);
  });

  it("refuses private and reserved IPv4 literals", () => {
    for (const host of [
      "10.0.0.5",
      "127.0.0.1",
      "127.8.9.10",
      "169.254.169.254", // cloud metadata
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "192.0.0.1",
      "100.64.0.1", // CGNAT
      "198.18.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(publicDialUrlError(`http://${host}:19001`), host).toMatch(/private or reserved/);
    }
    // Adjacent PUBLIC ranges stay dialable.
    for (const host of ["172.15.0.1", "172.32.0.1", "100.63.0.1", "9.9.9.9", "198.20.0.1"]) {
      expect(publicDialUrlError(`http://${host}`), host).toBeNull();
    }
  });

  it("refuses loopback, link-local, mapped, and ULA IPv6 literals", () => {
    for (const host of [
      "[::1]",
      "[::]",
      "[fe80::1]",
      "[fc00::1]",
      "[fd12:3456::1]",
      "[::ffff:127.0.0.1]",
      "[::ffff:192.168.1.1]",
    ]) {
      expect(publicDialUrlError(`http://${host}:8080`), host).toMatch(/private or reserved/);
    }
    expect(publicDialUrlError("http://[2606:4700::6810:84e5]")).toBeNull();
  });

  it("allowPrivate opts out of range checks but never scheme/credential checks", () => {
    const opts = { allowPrivate: true };
    expect(publicDialUrlError("http://192.168.1.20:19001", opts)).toBeNull();
    expect(publicDialUrlError("http://localhost:19001", opts)).toBeNull();
    expect(publicDialUrlError("file:///etc/passwd", opts)).toMatch(/scheme/);
    expect(publicDialUrlError("https://user:pass@192.168.1.20", opts)).toMatch(/credentials/);
  });
});
