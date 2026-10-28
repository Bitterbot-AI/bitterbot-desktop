import { useEffect, useState } from "react";
import type { SoapboxJob } from "../../../../../src/infra/soapbox-client";

export function PaymentPanel({
  job,
  busy,
  fund,
  canFund = true,
  replaceQuote,
}: {
  job: SoapboxJob;
  busy: boolean;
  fund: () => void;
  canFund?: boolean;
  replaceQuote?: () => void;
}) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(timer);
  }, []);
  if (!job.payment) return null;
  const payment = job.payment;
  const deadline = job.deadline && payment.expires ? Math.min(job.deadline, payment.expires) : 0;
  const seconds = Math.max(0, Math.ceil(deadline - now));
  const expired = deadline > 0 && seconds === 0;
  const replaceable =
    expired &&
    job.attempts === 0 &&
    ["awaiting_payment", "cancelled", "refunded"].includes(job.status);
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
      {job.status === "awaiting_payment" && deadline > 0 && (
        <p className="font-medium" role="timer" aria-label="Funding time remaining">
          {expired
            ? "Funding window expired"
            : `Fund within ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`}
        </p>
      )}
      {replaceable && (
        <p>
          This quote expired before execution. Request a fresh quote and review its price before
          funding.
        </p>
      )}
      {canFund && replaceable && replaceQuote && (
        <button
          className="rounded-lg border border-border px-4 py-2 disabled:opacity-40"
          disabled={busy}
          onClick={replaceQuote}
        >
          Request fresh quote
        </button>
      )}
      {canFund && job.status === "awaiting_payment" && seconds > 0 && (
        <button
          className="rounded-lg bg-brand px-4 py-2 text-white disabled:opacity-40"
          disabled={busy}
          onClick={fund}
        >
          Fund {(payment.amount_microusdc / 1e6).toFixed(6)} test USDC
        </button>
      )}
      {job.status === "awaiting_payment" && !deadline && (
        <p>Funding deadline unavailable. Refresh this job before funding.</p>
      )}
      {job.status === "settlement_pending" && (
        <p>Work completed. Waiting for the operator’s on-chain payout.</p>
      )}
      {job.status === "succeeded" && <p>Operator payment confirmed on chain.</p>}
      {job.status === "refund_pending" && (
        <p>
          Waiting for the old escrow to be refunded or voided. A replacement quote becomes available
          after this is confirmed.
        </p>
      )}
      {job.status === "refunded" && <p>Refund to the buyer confirmed on chain.</p>}
    </section>
  );
}
