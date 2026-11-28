import { Mic, MicOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { cn } from "../../lib/utils";
import {
  startVoiceSession,
  type VoicePhase,
  type VoiceSession,
} from "../../lib/voice/voice-session";

const LABEL: Record<VoicePhase, string> = {
  off: "Talk",
  listening: "Listening",
  hearing: "Hearing you",
  thinking: "Thinking",
  speaking: "Speaking (talk to interrupt)",
  error: "Voice error",
};

/** Voice mode toggle in the composer (PLAN-53 F3). */
export function VoiceButton({ disabled }: { disabled?: boolean }) {
  const [phase, setPhase] = useState<VoicePhase>("off");
  const session = useRef<VoiceSession | null>(null);

  useEffect(() => () => session.current?.stop(), []);

  const toggle = async () => {
    if (session.current) {
      session.current.stop();
      session.current = null;
      return;
    }
    try {
      session.current = await startVoiceSession((p, detail) => {
        setPhase(p);
        if (p === "error" && detail) toast.error("Voice", { description: detail });
      });
    } catch (err) {
      toast.error("Could not use the microphone", {
        description: err instanceof Error ? err.message : String(err),
      });
      setPhase("off");
    }
  };

  const on = phase !== "off";
  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={disabled}
      aria-pressed={on}
      title={on ? `${LABEL[phase]}. Click to stop talking.` : "Talk to BitterBot"}
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-full transition-colors disabled:opacity-40",
        on ? "bg-brand text-brand-foreground" : "text-ink-secondary hover:bg-hover hover:text-ink",
        phase === "hearing" && "animate-pulse",
      )}
    >
      {on ? (
        <Mic className="size-[18px]" strokeWidth={1.75} />
      ) : (
        <MicOff className="size-[18px]" strokeWidth={1.75} />
      )}
      <span className="sr-only">{on ? LABEL[phase] : "Talk"}</span>
    </button>
  );
}
