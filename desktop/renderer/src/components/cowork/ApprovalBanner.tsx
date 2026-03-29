import { useState, useCallback } from "react";
import { ShieldCheck, X } from "lucide-react";
import { cn } from "../../lib/utils";

interface ApprovalBannerProps {
  message: string;
  onApprove: () => void;
  onDeny: () => void;
  onDismiss?: () => void;
}

/**
 * Non-blocking approval banner for pending exec approvals.
 * Shows at the top of the panel when an agent needs permission to run a command.
 */
export function ApprovalBanner({ message, onApprove, onDeny, onDismiss }: ApprovalBannerProps) {
  const [dismissed, setDismissed] = useState(false);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    onDismiss?.();
  }, [onDismiss]);

  if (dismissed) return null;

  return (
    <div className="mx-2 mt-2 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
      <div className="flex items-start gap-2">
        <ShieldCheck className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-xs text-amber-200 font-medium">Approval Required</p>
          <p className="text-[11px] text-amber-200/70 mt-0.5 line-clamp-3">{message}</p>
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={onApprove}
              className={cn(
                "px-3 py-1 rounded-md text-[11px] font-medium transition-colors",
                "bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 border border-emerald-500/20",
              )}
            >
              Approve
            </button>
            <button
              onClick={onDeny}
              className={cn(
                "px-3 py-1 rounded-md text-[11px] font-medium transition-colors",
                "bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20",
              )}
            >
              Deny
            </button>
          </div>
        </div>
        <button
          onClick={handleDismiss}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
