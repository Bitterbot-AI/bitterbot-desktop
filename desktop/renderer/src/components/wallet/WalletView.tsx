import {
  Wallet,
  Copy,
  ExternalLink,
  ArrowUpRight,
  ArrowDownLeft,
  Fuel,
  Shield,
  KeyRound,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";
import {
  useWalletStore,
  type WalletTransaction,
  type WalletConfig,
} from "../../stores/wallet-store";

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).catch(() => {});
}

function truncateHash(hash: string): string {
  if (hash.length <= 16) return hash;
  return `${hash.slice(0, 8)}...${hash.slice(-6)}`;
}

function formatBalance(raw: string, token: string): string {
  const num = parseFloat(raw);
  if (isNaN(num)) return raw;
  if (token === "USDC" || token === "USDT" || token === "DAI") {
    return `$${num.toFixed(2)}`;
  }
  if (num === 0) return "0";
  if (num < 0.0001) return "<0.0001";
  return num.toFixed(6);
}

function StatCard({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: string;
  sub?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4">
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <p className="text-xs text-muted-foreground">{label}</p>
      </div>
      <p className="text-xl font-semibold text-foreground">{value}</p>
      {sub && <p className="text-xs text-muted-foreground/60 mt-1">{sub}</p>}
    </div>
  );
}

function TransactionRow({ tx, network }: { tx: WalletTransaction; network: string | null }) {
  const isOutgoing = tx.type === "send" || tx.type === "trade" || tx.type === "x402_payment";
  const isX402 = tx.type === "x402_payment";
  const explorerBase =
    network === "base" ? "https://basescan.org/tx/" : "https://sepolia.basescan.org/tx/";
  const displayType = isX402 ? "x402 Payment" : tx.type;

  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-border/5 last:border-0 hover:bg-muted/20">
      <div className="flex items-center gap-3 min-w-0">
        <div
          className={cn(
            "w-8 h-8 rounded-full flex items-center justify-center",
            isX402
              ? "bg-blue-500/10 text-blue-400"
              : isOutgoing
                ? "bg-orange-500/10 text-orange-400"
                : "bg-emerald-500/10 text-emerald-400",
          )}
        >
          {isOutgoing ? (
            <ArrowUpRight className="w-4 h-4" />
          ) : (
            <ArrowDownLeft className="w-4 h-4" />
          )}
        </div>
        <div className="min-w-0">
          <span className="text-sm text-foreground capitalize block">{displayType}</span>
          <a
            href={`${explorerBase}${tx.txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-muted-foreground/60 hover:text-purple-400 font-mono"
          >
            {truncateHash(tx.txHash)}
          </a>
        </div>
      </div>
      <div className="text-right flex-shrink-0">
        <span
          className={cn("text-sm font-medium", isOutgoing ? "text-orange-400" : "text-emerald-400")}
        >
          {isOutgoing ? "-" : "+"}
          {tx.amount} {tx.token}
        </span>
        {tx.timestamp > 0 && (
          <p className="text-[10px] text-muted-foreground/40">
            {new Date(tx.timestamp).toLocaleDateString()}
          </p>
        )}
      </div>
    </div>
  );
}

export function WalletView() {
  const gwStatus = useGatewayStore((s) => s.status);
  const request = useGatewayStore((s) => s.request);
  const address = useWalletStore((s) => s.address);
  const network = useWalletStore((s) => s.network);
  const balances = useWalletStore((s) => s.balances);
  const transactions = useWalletStore((s) => s.transactions);
  const loading = useWalletStore((s) => s.loading);
  const setAddress = useWalletStore((s) => s.setAddress);
  const setBalances = useWalletStore((s) => s.setBalances);
  const setTransactions = useWalletStore((s) => s.setTransactions);
  const setLoading = useWalletStore((s) => s.setLoading);
  const setError = useWalletStore((s) => s.setError);

  const [walletConfig, setWalletConfig] = useState<WalletConfig | null>(null);
  const [copied, setCopied] = useState(false);
  const [failReason, setFailReason] = useState<"disabled" | "unconfigured" | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    if (gwStatus !== "connected") return;
    setLoading(true);
    setError(null);
    setFailReason(null);
    try {
      // Config endpoint reads static config — works even when wallet is disabled
      const configRes = await request<WalletConfig>("wallet.getConfig");
      setWalletConfig(configRes);

      if (!configRes.enabled) {
        setFailReason("disabled");
        return;
      }

      const addrRes = await request<{ address: string; network: string }>("wallet.getAddress");
      setAddress(addrRes.address, addrRes.network);

      const [ethBal, usdcBal, historyRes] = await Promise.allSettled([
        request<{ token: string; balance: string; usdValue?: string }>("wallet.getBalance", {
          token: "ETH",
        }),
        request<{ token: string; balance: string; usdValue?: string }>("wallet.getBalance", {
          token: "USDC",
        }),
        request<{ transactions: WalletTransaction[] }>("wallet.getHistory", {
          limit: 20,
        }),
      ]);

      const bals = [];
      if (ethBal.status === "fulfilled") bals.push(ethBal.value);
      if (usdcBal.status === "fulfilled") bals.push(usdcBal.value);
      setBalances(bals);

      if (historyRes.status === "fulfilled") {
        setTransactions(historyRes.value.transactions);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("disabled")) {
        setFailReason("disabled");
      } else {
        setFailReason("unconfigured");
      }
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [gwStatus, request, setAddress, setBalances, setTransactions, setLoading, setError]);

  useEffect(() => {
    refresh();
    intervalRef.current = setInterval(refresh, 30_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [refresh]);

  const handleCopyAddress = () => {
    if (!address) return;
    copyToClipboard(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleFundWallet = async () => {
    try {
      const res = await request<{ fundingUrl: string; network: string }>("wallet.fund");
      if (res.fundingUrl) {
        window.open(res.fundingUrl, "_blank");
        return;
      }
    } catch {
      // Fallback: construct URL client-side
    }
    if (address) {
      const url =
        network === "base-sepolia"
          ? `https://portal.cdp.coinbase.com/products/faucet?address=${address}&network=base-sepolia`
          : `https://pay.coinbase.com/buy?addresses={"${address}":["base"]}&assets=["USDC"]`;
      window.open(url, "_blank");
    }
  };

  const explorerBase =
    network === "base" ? "https://basescan.org/address/" : "https://sepolia.basescan.org/address/";

  // Empty state: wallet disabled or provider failed to initialize
  if (!address && !loading && failReason) {
    const isDisabled = failReason === "disabled";
    return (
      <div className="h-full overflow-y-auto p-6 space-y-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Wallet</h1>
          <p className="text-sm text-muted-foreground mt-1">Coinbase AgentKit wallet on Base L2</p>
        </div>
        <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-6 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-amber-500/10 flex items-center justify-center">
              <KeyRound className="w-5 h-5 text-amber-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-foreground">
                {isDisabled ? "Wallet Disabled" : "Setup Required"}
              </h2>
              <p className="text-sm text-muted-foreground">
                {isDisabled
                  ? "The wallet has been disabled in your configuration."
                  : "Configure your CDP API keys to enable the wallet."}
              </p>
            </div>
          </div>
          {isDisabled ? (
            <p className="text-sm text-muted-foreground pl-2">
              Set{" "}
              <code className="text-xs bg-muted/40 px-1 py-0.5 rounded">
                tools.wallet.enabled: true
              </code>{" "}
              in your config and restart to enable wallet functionality.
            </p>
          ) : (
            <ol className="list-decimal list-inside text-sm text-muted-foreground space-y-2 pl-2">
              <li>
                Go to{" "}
                <a
                  href="https://portal.cdp.coinbase.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-purple-400 hover:underline"
                >
                  portal.cdp.coinbase.com
                </a>{" "}
                and create an API key
              </li>
              <li>
                Add <code className="text-xs bg-muted/40 px-1 py-0.5 rounded">CDP_API_KEY_ID</code>{" "}
                and{" "}
                <code className="text-xs bg-muted/40 px-1 py-0.5 rounded">CDP_API_KEY_SECRET</code>{" "}
                to your environment or config
              </li>
              <li>Restart the gateway</li>
            </ol>
          )}
          <button
            onClick={refresh}
            className={cn(
              "px-4 py-2 text-sm rounded-lg mt-2",
              "bg-purple-500/10 text-purple-300 hover:bg-purple-500/20",
              "border border-purple-500/20 transition-colors",
            )}
          >
            Retry Connection
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-foreground">Wallet</h1>
            {network && (
              <span
                className={cn(
                  "text-xs font-medium px-2 py-0.5 rounded-full",
                  network === "base"
                    ? "bg-emerald-500/15 text-emerald-400"
                    : "bg-amber-500/15 text-amber-400",
                )}
              >
                {network === "base" ? "Base Mainnet" : "Base Sepolia"}
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-1">Coinbase AgentKit wallet on Base L2</p>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className={cn(
            "px-3 py-1.5 text-xs rounded-lg",
            "bg-purple-500/10 text-purple-300 hover:bg-purple-500/20",
            "border border-purple-500/20 transition-colors",
            loading && "opacity-50",
          )}
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {/* Address card */}
      {address && (
        <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-purple-500/10 flex items-center justify-center">
                <Wallet className="w-5 h-5 text-purple-400" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Wallet Address</p>
                <p className="text-sm font-mono text-foreground">{address}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleCopyAddress}
                className="p-2 rounded-lg hover:bg-muted/30 text-muted-foreground hover:text-foreground transition-colors"
                title="Copy address"
              >
                <Copy className="w-4 h-4" />
              </button>
              <a
                href={`${explorerBase}${address}`}
                target="_blank"
                rel="noopener noreferrer"
                className="p-2 rounded-lg hover:bg-muted/30 text-muted-foreground hover:text-foreground transition-colors"
                title="View on BaseScan"
              >
                <ExternalLink className="w-4 h-4" />
              </a>
            </div>
          </div>
          {copied && <p className="text-xs text-emerald-400 mt-2">Address copied!</p>}
        </div>
      )}

      {/* Balance cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {balances.map((bal) => (
          <StatCard
            key={bal.token}
            label={bal.token}
            value={formatBalance(bal.balance, bal.token)}
            sub={bal.usdValue ? `$${bal.usdValue}` : undefined}
          />
        ))}
        {/* Spend caps */}
        {walletConfig && (
          <>
            <StatCard
              label="Session Cap"
              value={`$${walletConfig.sessionSpendCapUsd}`}
              sub="per session limit"
              icon={<Shield className="w-3.5 h-3.5 text-amber-400" />}
            />
            <StatCard
              label="Per-TX Cap"
              value={`$${walletConfig.perTransactionCapUsd}`}
              sub="per transaction limit"
              icon={<Shield className="w-3.5 h-3.5 text-amber-400" />}
            />
            <StatCard
              label="Daily Limit"
              value={`$${walletConfig.dailySpendLimitUsd}`}
              sub="24-hour rolling cap"
              icon={<Shield className="w-3.5 h-3.5 text-amber-400" />}
            />
            <StatCard
              label="x402"
              value={
                walletConfig.x402Enabled ? `$${walletConfig.x402MaxPerRequestUsd}/req` : "Disabled"
              }
              sub={walletConfig.x402Enabled ? "micropayment protocol" : "enable in config"}
              icon={<Shield className="w-3.5 h-3.5 text-blue-400" />}
            />
          </>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-3">
        <button
          onClick={handleFundWallet}
          className={cn(
            "flex items-center gap-2 px-4 py-2 text-sm rounded-lg",
            "bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20",
            "border border-emerald-500/20 transition-colors",
          )}
        >
          <Fuel className="w-4 h-4" />
          {network === "base-sepolia" ? "Get Testnet Tokens" : "Fund Wallet"}
        </button>
      </div>

      {/* Transaction history */}
      <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm overflow-hidden">
        <h3 className="text-sm font-medium text-foreground px-4 py-3 border-b border-border/10">
          Transaction History
        </h3>
        {transactions.length > 0 ? (
          <div className="max-h-[400px] overflow-y-auto">
            {transactions.map((tx, i) => (
              <TransactionRow key={tx.txHash || i} tx={tx} network={network} />
            ))}
          </div>
        ) : (
          <div className="px-4 py-8 text-center">
            <p className="text-sm text-muted-foreground">No transactions yet</p>
            <p className="text-xs text-muted-foreground/60 mt-1">
              Fund your wallet and start transacting
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
