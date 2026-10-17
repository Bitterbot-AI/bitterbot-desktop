import { useEffect, useState } from "react";
import type { SoapboxWalletStatus } from "../../../../../src/infra/soapbox-client";
import { useGatewayStore } from "../../stores/gateway-store";

export function ComputeWalletPanel() {
  const request = useGatewayStore((s) => s.request);
  const [wallet, setWallet] = useState<SoapboxWalletStatus | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const status = await request<SoapboxWalletStatus>("soapbox.wallet");
        if (!disposed) {
          setWallet(status);
          setError(false);
        }
      } catch {
        if (!disposed) setError(true);
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), 15000);
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [request]);
  return (
    <section
      aria-label="Compute test wallet"
      className="rounded-xl border border-border bg-muted/20 p-4 space-y-2"
    >
      <h2 className="font-medium">Compute test wallet · Base Sepolia</h2>
      <p className="text-sm">{wallet?.balance_usdc ?? "—"} test USDC</p>
      {wallet?.address && <p className="font-mono text-xs break-all">{wallet.address}</p>}
      <p className="text-xs text-muted-foreground">
        Separate account and spending history. Your main Wallet stays on its current network.
        Compute can spend up to 0.10 test USDC per job and 1 test USDC per day.
      </p>
      {(error || wallet?.error) && (
        <p className="text-xs text-warning">Test wallet balance unavailable; retrying.</p>
      )}
    </section>
  );
}
