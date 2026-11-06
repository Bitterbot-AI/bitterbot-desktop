import { CheckCircle2, Laptop, QrCode, ShieldAlert, Terminal, XCircle } from "lucide-react";
import { BitterBotAvatar } from "../../components/chat/BitterBotAvatar";
import { AVATAR_SRC, Wordmark } from "../components/Chrome";
import { formatConfirmCode } from "../pairing-client";
import { useMobile } from "../store";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mobile-shell mobile-ground">
      <div className="flex flex-1 flex-col overflow-y-auto px-6 pt-[calc(var(--m-safe-top)+2.5rem)] pb-[calc(var(--m-safe-bottom)+1.5rem)]">
        {children}
      </div>
    </div>
  );
}

/** Not paired yet (or just unpaired): how to get the pairing link. */
export function WelcomeScreen() {
  const reason = useMobile((s) => s.unpairedReason);
  return (
    <Shell>
      <div className="m-fade-in flex flex-col items-center text-center">
        <BitterBotAvatar size={88} src={AVATAR_SRC} isThinking />
        <h1 className="mt-5 text-2xl">
          <Wordmark />
        </h1>
        <p className="mt-2 max-w-xs text-sm leading-relaxed text-muted-foreground">
          Your own agent, on your phone. Pair this phone with your Bitterbot gateway to chat, answer
          approvals and get notified.
        </p>
      </div>
      {reason ? (
        <div className="m-fade-in mt-6 rounded-2xl bg-[var(--m-surface-strong)] px-4 py-3 text-center text-sm">
          {reason}
        </div>
      ) : null}
      <div className="m-fade-in mt-8 flex flex-col gap-3">
        <p className="m-section-label px-1">Pair from your computer</p>
        {[
          {
            icon: QrCode,
            title: "Control UI",
            text: "Open Devices, choose Pair a phone and scan the code with your camera.",
          },
          {
            icon: Terminal,
            title: "Terminal",
            text: "Run bitterbot devices pair and scan the code it prints.",
          },
          {
            icon: Laptop,
            title: "From a chat app",
            text: "Send /pair to your Bitterbot and open the link on this phone.",
          },
        ].map((item) => (
          <div key={item.title} className="m-card flex items-start gap-3 p-4">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
              <item.icon className="size-[1.125rem]" />
            </div>
            <div>
              <p className="text-sm font-semibold">{item.title}</p>
              <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{item.text}</p>
            </div>
          </div>
        ))}
      </div>
      <p className="mt-auto pt-8 text-center text-xs text-muted-foreground">
        Pairing links work once and expire after five minutes. Your gateway password never leaves
        your computer.
      </p>
    </Shell>
  );
}

/** Claimed a setup code: show the confirmation number and wait for the owner. */
export function PairScreen() {
  const pairing = useMobile((s) => s.pairing);
  const insecure = useMobile((s) => s.insecure);
  const step = pairing?.step ?? "claiming";
  return (
    <Shell>
      <div className="m-fade-in flex flex-1 flex-col items-center justify-center text-center">
        <div className="relative mb-8">
          {step === "waiting" || step === "claiming" ? <span className="m-pulse-ring" /> : null}
          <BitterBotAvatar size={76} src={AVATAR_SRC} isThinking={step !== "failed"} />
        </div>

        {step === "claiming" && (
          <>
            <h1 className="text-xl font-semibold">Making this phone's key…</h1>
            <p className="mt-2 text-sm text-muted-foreground">One moment.</p>
          </>
        )}

        {(step === "waiting" || step === "approved") && pairing?.confirmCode && (
          <>
            <p className="m-section-label">Pairing code</p>
            <p
              className="m-confirm-code mt-3 text-foreground"
              aria-label={`Code ${pairing.confirmCode.split("").join(" ")}`}
            >
              {formatConfirmCode(pairing.confirmCode)}
            </p>
            {step === "waiting" ? (
              <p className="mt-6 max-w-xs text-sm leading-relaxed text-muted-foreground">
                Check that your computer shows the same code, then approve it there. If the codes
                differ, do not approve.
              </p>
            ) : (
              <p className="mt-6 flex items-center gap-2 text-base font-semibold text-success">
                <CheckCircle2 className="size-5" />
                Paired. Welcome.
              </p>
            )}
          </>
        )}

        {step === "failed" && (
          <>
            <XCircle className="mb-3 size-8 text-danger" />
            <h1 className="text-xl font-semibold">Pairing did not finish</h1>
            <p className="mt-2 max-w-xs text-sm leading-relaxed text-muted-foreground">
              {pairing?.error}
            </p>
            <button
              type="button"
              onClick={() => useMobile.setState({ phase: "welcome", pairing: null })}
              className="m-press m-touch mt-6 rounded-xl bg-[var(--m-surface-strong)] px-5 text-sm font-semibold"
            >
              Back
            </button>
          </>
        )}
      </div>
      {insecure && step !== "failed" ? (
        <p className="m-fade-in mt-6 flex items-start gap-2 rounded-xl bg-warning/10 px-3 py-2 text-left text-xs text-warning">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          This page is on plain HTTP, so anyone on this network could watch the traffic. Pair over
          Tailscale (HTTPS) when you can.
        </p>
      ) : null}
    </Shell>
  );
}
