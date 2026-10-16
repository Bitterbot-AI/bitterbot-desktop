/**
 * One-time offer of a base personality (GENOME.md's Temperament section) to
 * an agent created before it existed. Preview / Add / Not now; dismissal
 * persists per browser; hidden once the section exists. Adding writes only
 * that section (genome.temperament.apply); the rest of the Genome and the
 * Phenotype are untouched.
 */
import { X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";

const DISMISS_KEY = "bitterbot-temperament-offer-dismissed";

type Level = "calm" | "playful" | "irreverent";

const LEVELS: Array<{ value: Level; label: string; hint: string }> = [
  { value: "calm", label: "Calm", hint: "Dry, few jokes, no swearing" },
  { value: "playful", label: "Playful", hint: "Warm humor, swears only if you do" },
  { value: "irreverent", label: "Irreverent", hint: "Witty, swears where it fits" },
];

type Status = {
  genomeExists: boolean;
  present: boolean;
  level?: Level;
  preview: string;
};

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function TemperamentCard() {
  const status = useGatewayStore((s) => s.status);
  const request = useGatewayStore((s) => s.request);
  const [dismissed, setDismissed] = useState<boolean>(readDismissed);
  const [offer, setOffer] = useState<Status | null>(null);
  const [level, setLevel] = useState<Level>("irreverent");
  const [showPreview, setShowPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (previewLevel: Level) => {
      if (status !== "connected" || dismissed) return;
      try {
        setOffer(await request<Status>("genome.temperament.status", { level: previewLevel }));
      } catch {
        // An older gateway without the method: nothing to offer.
        setOffer(null);
      }
    },
    [status, request, dismissed],
  );

  useEffect(() => {
    void load(level);
  }, [load, level]);

  if (dismissed || !offer || !offer.genomeExists || offer.present) {
    return null;
  }

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* per-browser convenience only */
    }
  };

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await request<{ status: Status }>("genome.temperament.apply", {
        action: "add",
        level,
      });
      setOffer(result.status);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="temperament-card"
      className="rounded-xl border border-brand/20 bg-brand/5 p-4"
    >
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-medium text-foreground">
          A base personality is available for your agent
        </h2>
        <button
          onClick={dismiss}
          title="Not now"
          className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <p className="text-sm text-muted-foreground mb-3">
        A Temperament section for GENOME.md: the voice your agent starts from. Its Phenotype keeps
        evolving from there. Nothing else in GENOME.md changes, and you can change the level any
        time with <code>bitterbot genome temperament --level</code>.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-muted-foreground" htmlFor="temperament-level">
          Vibe
        </label>
        <select
          id="temperament-level"
          value={level}
          onChange={(e) => setLevel(e.target.value as Level)}
          className="text-xs rounded border border-border/40 bg-card px-2 py-1"
        >
          {LEVELS.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}: {l.hint}
            </option>
          ))}
        </select>
        <button
          onClick={() => setShowPreview((v) => !v)}
          className="px-2 py-1 text-xs rounded bg-brand/10 text-brand hover:bg-brand/30 border border-brand/20 transition-colors"
        >
          {showPreview ? "Hide preview" : "Preview"}
        </button>
        <button
          onClick={() => void add()}
          disabled={busy}
          className={cn(
            "px-2 py-1 text-xs rounded bg-brand text-white hover:bg-brand/80 transition-colors",
            busy && "opacity-50",
          )}
        >
          {busy ? "Adding…" : "Add"}
        </button>
        <button
          onClick={dismiss}
          className="px-2 py-1 text-xs rounded text-muted-foreground hover:text-foreground transition-colors"
        >
          Not now
        </button>
      </div>
      {showPreview && (
        <pre
          data-testid="temperament-preview"
          className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded border border-border/20 bg-card/60 p-3 text-xs text-foreground"
        >
          {offer.preview}
        </pre>
      )}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}
