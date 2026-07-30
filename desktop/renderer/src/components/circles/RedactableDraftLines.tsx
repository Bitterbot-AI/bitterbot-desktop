import { useMemo, useState } from "react";
import { cn } from "../../lib/utils";

// The mockup's consent-card interaction ("share only what you choose"):
// an agent draft is reviewed LINE BY LINE — tap "redact" on a line and it
// is struck locally and never published; tap "share" to restore it. "Edit
// first" switches to the free-text editor (maximal control) — the two modes
// are alternatives, and whichever is active decides exactly what ships.
// Everything here is node-local; redacted lines are never transmitted.

export function RedactableDraftLines({
  lines,
  redacted,
  onToggle,
}: {
  lines: string[];
  redacted: Set<number>;
  onToggle: (index: number) => void;
}) {
  return (
    <div className="space-y-0.5">
      {lines.map((line, i) => {
        const off = redacted.has(i);
        return (
          <div key={`${i}-${line.slice(0, 12)}`} className="flex items-start gap-2 text-sm">
            <span
              className={cn(
                "flex-1 min-w-0 whitespace-pre-wrap break-words",
                off && "line-through text-muted-foreground/60",
              )}
            >
              {line || " "}
            </span>
            {line.trim() !== "" && (
              <button
                type="button"
                onClick={() => onToggle(i)}
                className={cn(
                  "shrink-0 text-2xs rounded border px-1.5 py-0.5",
                  off
                    ? "text-circle-you border-circle-you/50"
                    : "text-muted-foreground border-border hover:text-foreground",
                )}
              >
                {off ? "share" : "redact"}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Hook: line-level redact state over a draft, with a text-edit escape hatch. */
export function useDraftConsent(initial: string) {
  const [text, setText] = useState(initial);
  // The mode is LATCHED at mount (review #7): single-line drafts start in the
  // editor and stay there — otherwise typing a second line would swap the
  // textarea out from under the user mid-keystroke. Multi-line drafts start
  // in line review; "Edit first" is the one-way switch to the editor.
  const [editing, setEditing] = useState(
    () => initial.split("\n").filter((l) => l.trim() !== "").length <= 1,
  );
  const [redacted, setRedacted] = useState<Set<number>>(new Set());
  const lines = useMemo(() => text.split("\n"), [text]);

  const toggle = (i: number) => {
    setRedacted((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  /** What actually ships, under the active mode. */
  const finalText = () =>
    editing
      ? text.trim()
      : lines
          .filter((_, i) => !redacted.has(i))
          .join("\n")
          .trim();

  const startEditing = () => {
    // Entering the editor collapses the redactions into the text so what
    // you see is what ships — no hidden struck lines behind the textarea.
    if (redacted.size > 0) {
      setText(lines.filter((_, i) => !redacted.has(i)).join("\n"));
      setRedacted(new Set());
    }
    setEditing(true);
  };

  return {
    text,
    setText,
    editing,
    startEditing,
    redacted,
    toggle,
    lines,
    finalText,
  };
}
