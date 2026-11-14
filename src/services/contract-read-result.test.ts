import { describe, expect, it } from "vitest";
import { contractAddress, contractEscrowJob, contractUint } from "./contract-read-result.js";

describe("untyped contract read boundary", () => {
  it("preserves exact uint values and refuses coercion or negative balances", () => {
    expect(contractUint(2n ** 200n)).toBe(2n ** 200n);
    for (const value of ["100", 100, -1n, null, {}, undefined])
      expect(() => contractUint(value)).toThrow("Invalid contract uint");
  });
  it("rejects malformed address results", () => {
    expect(contractAddress(`0x${"a".repeat(40)}`)).toBe(`0x${"a".repeat(40)}`);
    for (const value of [null, {}, "0x123", `0x${"z".repeat(40)}`])
      expect(() => contractAddress(value)).toThrow("Invalid contract address");
  });
  it("requires a complete typed escrow tuple before interpreting funded state", () => {
    const tuple = [
      `0x${"1".repeat(40)}`,
      `0x${"2".repeat(40)}`,
      33n,
      100n,
      1n,
      `0x${"0".repeat(64)}`,
    ];
    expect(contractEscrowJob(tuple)).toEqual(tuple);
    expect(() => contractEscrowJob(tuple.slice(0, 5))).toThrow("Invalid escrow job");
    for (let index = 0; index < tuple.length; index++) {
      const malformed: unknown[] = [...tuple];
      malformed[index] = null;
      expect(() => contractEscrowJob(malformed)).toThrow();
    }
  });
});
