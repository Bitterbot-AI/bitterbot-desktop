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
        "w-8 h-8 rounded-lg flex items-center justify-center transition-all disabled:opacity-30",
        on ? "bg-brand text-white" : "text-muted-foreground hover:text-foreground",
        phase === "hearing" && "animate-pulse",
      )}
    >
      {on ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
      <span className="sr-only">{on ? LABEL[phase] : "Talk"}</span>
    </button>
  );
}
