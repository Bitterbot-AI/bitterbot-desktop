/**
 * PLAN-41 p0-16: in-app replacement for `window.confirm`. One hook per view:
 *
 *   const [confirm, confirmElement] = useConfirm();
 *   ...
 *   if (!(await confirm({ title: "Remove job?", actionLabel: "Remove" }))) return;
 *   ...
 *   return <>{...view...}{confirmElement}</>;
 *
 * Resolves false on cancel/dismiss, true on the action button — a drop-in
 * for the old native gate, but themed, testable, and lint-enforceable
 * (no-alert turns on once every native dialog is gone).
 */
import { useCallback, useRef, useState, type JSX } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./alert-dialog";

export type ConfirmOptions = {
  title: string;
  description?: string;
  actionLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
};

export function useConfirm(): [(opts: ConfirmOptions) => Promise<boolean>, JSX.Element] {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolveRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((next: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      // A second confirm while one is open cancels the first — native
      // confirm() could never stack either.
      resolveRef.current?.(false);
      resolveRef.current = resolve;
      setOpts(next);
    });
  }, []);

  const settle = (value: boolean) => {
    resolveRef.current?.(value);
    resolveRef.current = null;
    setOpts(null);
  };

  const element = (
    <AlertDialog open={opts !== null} onOpenChange={(open) => !open && settle(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{opts?.title}</AlertDialogTitle>
          {opts?.description && <AlertDialogDescription>{opts.description}</AlertDialogDescription>}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => settle(false)}>
            {opts?.cancelLabel ?? "Cancel"}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={() => settle(true)}
            className={opts?.destructive ? "bg-danger text-white hover:bg-danger/90" : undefined}
          >
            {opts?.actionLabel ?? "Confirm"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return [confirm, element];
}
