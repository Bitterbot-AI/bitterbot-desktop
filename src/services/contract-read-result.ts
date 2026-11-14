/** Validate SDK reads at the boundary: current SDKs intentionally return unknown. */
export function contractUint(value: unknown): bigint {
  if (typeof value !== "bigint" || value < 0n) throw new Error("Invalid contract uint result");
  return value;
}

export function contractAddress(value: unknown): `0x${string}` {
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/i.test(value))
    throw new Error("Invalid contract address result");
  return value as `0x${string}`;
}

export function contractEscrowJob(value: unknown) {
  if (!Array.isArray(value) || value.length !== 6) throw new Error("Invalid escrow job result");
  const fields: unknown[] = value;
  const [buyer, operator, amount, expires, state, result] = fields;
  if (typeof result !== "string" || !/^0x[0-9a-f]{64}$/i.test(result))
    throw new Error("Invalid escrow job result hash");
  return [
    contractAddress(buyer),
    contractAddress(operator),
    contractUint(amount),
    contractUint(expires),
    contractUint(state),
    result,
  ] as const;
}
