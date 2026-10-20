import type { SoapboxJob } from "../../../../../src/infra/soapbox-client";

export function PaymentPanel({
  job,
  busy,
  fund,
  canFund = true,
}: {
  job: SoapboxJob;
  busy: boolean;
  fund: () => void;
  canFund?: boolean;
}) {
  if (!job.payment) return null;
  const payment = job.payment;
  return (
    <section className="rounded-lg border border-border p-4 space-y-2 text-sm">
      <h3 className="font-medium">Base Sepolia USDC payment</h3>
      <p>
        {(payment.amount_microusdc / 1e6).toFixed(6)} test USDC · {job.status.replaceAll("_", " ")}
      </p>
      <p className="break-all text-xs">Operator receives: {payment.operator}</p>
      <p className="text-xs text-muted-foreground">
        Funding locks the quoted amount in escrow. Accepted work pays this operator; cancelled or
        expired work returns it to the buyer. The coordinator decides whether work is accepted.
      </p>
      {canFund && job.status === "awaiting_payment" && (
        <button
          className="rounded-lg bg-brand px-4 py-2 text-white disabled:opacity-40"
          disabled={busy}
          onClick={fund}
        >
          Fund {(payment.amount_microusdc / 1e6).toFixed(6)} test USDC
        </button>
      )}
      {job.status === "settlement_pending" && (
        <p>Work completed. Waiting for the operator’s on-chain payout.</p>
      )}
      {job.status === "succeeded" && <p>Operator payment confirmed on chain.</p>}
    </section>
  );
}
