import {
  CheckCircle2,
  Laptop,
  PlusSquare,
  QrCode,
  Share,
  ShieldAlert,
  Smartphone,
  Terminal,
  WifiOff,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { BitterBotAvatar } from "../../components/chat/BitterBotAvatar";
import { AVATAR_SRC, Wordmark } from "../components/Chrome";
import { parsePairInput } from "../install-handoff";
import { formatConfirmCode } from "../pairing-client";
import { isStandalone } from "../push";
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

/**
 * Opened on the Home Screen without a pairing: scanning a code opens Safari,
 * not this app, so a pasted link is the way in when the hand-over did not
 * arrive (the code ran out, or an iOS older than 17.2).
 */
function PasteLink() {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const code = parsePairInput(text);
    if (!code) {
      setError("That does not look like a pairing link.");
      return;
    }
    setError(null);
    useMobile.getState().receivePairCode(code);
  };
  return (
    <div className="m-card m-fade-in mt-6 flex flex-col gap-2 p-4">
      <p className="text-sm font-semibold">Have a pairing link?</p>
      <p className="text-sm leading-relaxed text-muted-foreground">
        Scanning a code opens Safari, not this app. On your computer choose Copy link, send it to
        this phone, then paste it here.
      </p>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        placeholder="Paste the pairing link"
        aria-label="Pairing link"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        className="m-touch rounded-xl bg-[var(--m-surface-strong)] px-3 text-base outline-none"
      />
      {error ? <p className="text-xs text-danger">{error}</p> : null}
      <button
        type="button"
        onClick={submit}
        disabled={!text.trim()}
        className="m-press m-touch rounded-xl bg-primary text-sm font-semibold text-primary-foreground disabled:opacity-50"
      >
        Pair
      </button>
    </div>
  );
}

/**
 * iPhone Safari opened a pairing link. Pairing here would stay in Safari:
 * the Home Screen app starts with empty storage. Install first; the app
 * finishes pairing when it opens (install-handoff.ts).
 */
export function InstallFirstScreen() {
  const pairInBrowserInstead = useMobile((s) => s.pairInBrowserInstead);
  return (
    <Shell>
      <div className="m-fade-in flex flex-col items-center text-center">
        <BitterBotAvatar size={76} src={AVATAR_SRC} isThinking />
        <h1 className="mt-5 text-xl font-semibold">Add Bitterbot to your Home Screen</h1>
        <p className="mt-2 max-w-xs text-sm leading-relaxed text-muted-foreground">
          Then open it from there and it finishes pairing on its own. That is the only way iPhone
          gives a web app notifications.
        </p>
      </div>
      <ol className="m-fade-in mt-8 flex flex-col gap-3">
        {[
          { icon: Share, text: "Tap the Share button in Safari's toolbar." },
          { icon: PlusSquare, text: "Choose Add to Home Screen, then Add." },
          { icon: Smartphone, text: "Open Bitterbot from the new icon within five minutes." },
        ].map((step, i) => (
          <li key={i} className="m-card flex items-center gap-3 p-3.5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
              <step.icon className="size-[1.125rem]" />
            </span>
            <span className="text-sm leading-snug">{step.text}</span>
          </li>
        ))}
      </ol>
      <div className="mt-auto flex flex-col items-center pt-8">
        <button
          type="button"
          onClick={pairInBrowserInstead}
          className="m-press m-touch rounded-xl px-5 text-sm font-semibold text-muted-foreground"
        >
          Use it in Safari instead (no notifications)
        </button>
      </div>
    </Shell>
  );
}

/** Not paired yet (or just unpaired): how to get the pairing link. */
export function WelcomeScreen() {
  const reason = useMobile((s) => s.unpairedReason);
  const installed = isStandalone();
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
      {installed ? <PasteLink /> : null}
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
              <>
                <p className="mt-6 max-w-xs text-sm leading-relaxed text-muted-foreground">
                  Check that your computer shows the same code, then approve it there. If the codes
                  differ, do not approve.
                </p>
                {pairing.offline ? (
                  <p className="mt-4 flex items-center gap-2 text-xs text-warning">
                    <WifiOff className="size-3.5" />
                    Can't reach your computer right now. Still waiting.
                  </p>
                ) : null}
              </>
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
            <h1 className="text-xl font-semibold">
              {pairing?.reason === "declined"
                ? "Pairing declined"
                : pairing?.reason === "expired"
                  ? "Pairing code expired"
                  : "Pairing did not finish"}
            </h1>
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
