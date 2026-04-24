import { Wallet, ExternalLink, Copy, RefreshCw } from "lucide-react";
import { useCallback, useEffect } from "react";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";
import { useUIStore, type TabId } from "../../stores/ui-store";
import { useWalletStore } from "../../stores/wallet-store";

function truncateAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).catch(() => {});
}

export function WalletSidebarPanel({ collapsed }: { collapsed: boolean }) {
  const gwStatus = useGatewayStore((s) => s.status);
  const request = useGatewayStore((s) => s.request);
  const address = useWalletStore((s) => s.address);
  const network = useWalletStore((s) => s.network);
  const balances = useWalletStore((s) => s.balances);
  const loading = useWalletStore((s) => s.loading);
  const error = useWalletStore((s) => s.error);
  const setAddress = useWalletStore((s) => s.setAddress);
  const setBalances = useWalletStore((s) => s.setBalances);
  const setLoading = useWalletStore((s) => s.setLoading);
  const setError = useWalletStore((s) => s.setError);
  const setActiveTab = useUIStore((s) => s.setActiveTab);

  const refresh = useCallback(async () => {
    if (gwStatus !== "connected") return;
    setLoading(true);
    setError(null);
    try {
      const addrRes = await request<{ address: string; network: string }>("wallet.getAddress");
      setAddress(addrRes.address, addrRes.network);

      // Fetch ETH and USDC balances in parallel
      const [ethBal, usdcBal] = await Promise.allSettled([
        request<{ token: string; balance: string; usdValue?: string }>("wallet.getBalance", {
          token: "ETH",
        }),
        request<{ token: string; balance: string; usdValue?: string }>("wallet.getBalance", {
          token: "USDC",
        }),
      ]);

      const bals = [];
      if (ethBal.status === "fulfilled") bals.push(ethBal.value);
      if (usdcBal.status === "fulfilled") bals.push(usdcBal.value);
      setBalances(bals);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load wallet");
    } finally {
      setLoading(false);
    }
  }, [gwStatus, request, setAddress, setBalances, setLoading, setError]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Collapsed: just show wallet icon
  if (collapsed) {
    return (
      <div className="border-b border-[var(--sidebar-border-subtle)] p-2">
        <button
          onClick={() => setActiveTab("wallet" as TabId)}
          title="Wallet"
          className={cn(
            "w-8 h-8 flex items-center justify-center rounded-md transition-colors",
            "text-[var(--sidebar-text-muted)] hover:text-emerald-400 hover:bg-[var(--sidebar-hover)]",
            address && "text-emerald-400",
          )}
        >
          <Wallet className="w-4 h-4" />
        </button>
      </div>
    );
  }

  // Whole panel navigates to the wallet tab. Inner buttons (copy, refresh)
  // stop propagation so they don't double-fire navigation.
  const openWalletTab = () => setActiveTab("wallet" as TabId);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={openWalletTab}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openWalletTab();
        }
      }}
      className="border-b border-[var(--sidebar-border-subtle)] px-4 py-3 cursor-pointer hover:bg-[var(--sidebar-hover)] transition-colors"
      title="Open wallet"
    >
      {/* Section header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-widest text-[#00D4E6]">
            WALLET
          </div>
          {network && (
            <span
              className={cn(
                "text-[9px] font-medium px-1.5 py-0.5 rounded-full",
                network === "base"
                  ? "bg-emerald-500/15 text-emerald-400"
                  : "bg-amber-500/15 text-amber-400",
              )}
            >
              {network === "base" ? "MAINNET" : "TESTNET"}
            </span>
          )}
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            refresh();
          }}
          disabled={loading}
          className={cn(
            "w-5 h-5 flex items-center justify-center rounded text-[var(--sidebar-text-muted)] hover:text-[var(--sidebar-text-primary)] transition-colors",
            loading && "animate-spin",
          )}
          title="Refresh wallet"
        >
          <RefreshCw className="w-3 h-3" />
        </button>
      </div>

      {error ? (
        <div className="flex items-center justify-between px-2 py-1">
          <span className="text-[11px] text-[var(--sidebar-text-muted)]">USDC</span>
          <span className="text-[12px] font-medium tabular-nums text-emerald-400">$0.00</span>
        </div>
      ) : (
        <>
          {/* Address */}
          {address && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                copyToClipboard(address);
              }}
              className="group flex items-center gap-1.5 w-full px-2 py-1 rounded-md hover:bg-[var(--sidebar-hover)] transition-colors mb-1.5"
              title={`Copy: ${address}`}
            >
              <span className="text-[11px] font-mono text-[var(--sidebar-text-secondary)]">
                {truncateAddress(address)}
              </span>
              <Copy className="w-3 h-3 text-[var(--sidebar-text-muted)] opacity-0 group-hover:opacity-100 transition-opacity" />
            </button>
          )}

          {/* Balances */}
          <div className="space-y-0.5">
            {balances.map((bal) => (
              <div
                key={bal.token}
                className="flex items-center justify-between px-2 py-1 rounded-md"
              >
                <span className="text-[11px] text-[var(--sidebar-text-muted)]">{bal.token}</span>
                <span
                  className={cn(
                    "text-[12px] font-medium tabular-nums",
                    parseFloat(bal.balance) > 0
                      ? "text-emerald-400"
                      : "text-[var(--sidebar-text-secondary)]",
                  )}
                >
                  {formatBalance(bal.balance, bal.token)}
                </span>
              </div>
            ))}
            {balances.length === 0 && !loading && (
              <div className="flex items-center justify-between px-2 py-1 rounded-md">
                <span className="text-[11px] text-[var(--sidebar-text-muted)]">USDC</span>
                <span className="text-[12px] font-medium tabular-nums text-emerald-400">$0.00</span>
              </div>
            )}
            {loading && (
              <div className="text-[11px] text-[var(--sidebar-text-muted)] px-2 py-1">
                Loading...
              </div>
            )}
          </div>

          {/* "Open wallet" affordance — the whole panel is clickable, this
              just makes the affordance visible. */}
          <div className="flex items-center gap-1 mt-2 px-2 py-1 text-[10px] text-purple-400">
            <span>Open wallet</span>
            <ExternalLink className="w-2.5 h-2.5" />
          </div>
        </>
      )}
    </div>
  );
}

function formatBalance(raw: string, token: string): string {
  const num = parseFloat(raw);
  if (isNaN(num)) return raw;
  if (token === "USDC" || token === "USDT" || token === "DAI") {
    return `$${num.toFixed(2)}`;
  }
  if (num === 0) return "0";
  if (num < 0.0001) return "<0.0001";
  return num.toFixed(4);
}
