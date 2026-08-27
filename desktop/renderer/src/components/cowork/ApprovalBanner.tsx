import { ShieldCheck, X } from "lucide-react";
import { useState, useCallback } from "react";
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
    <div className="mx-2 mt-2 rounded-lg border border-warning/20 bg-warning/5 p-3">
      <div className="flex items-start gap-2">
        <ShieldCheck className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-xs text-warning font-medium">Approval Required</p>
          <p className="text-2xs text-warning/70 mt-0.5 line-clamp-3">{message}</p>
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={onApprove}
              className={cn(
                "px-3 py-1 rounded-md text-2xs font-medium transition-colors",
                "bg-success/20 text-success hover:bg-success/40 border border-success/20",
              )}
            >
              Approve
            </button>
            <button
              onClick={onDeny}
              className={cn(
                "px-3 py-1 rounded-md text-2xs font-medium transition-colors",
                "bg-danger/10 text-danger hover:bg-danger/30 border border-danger/20",
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
