import { useState } from "react";
import { useChatStore } from "../../stores/chat-store";
import { cn } from "../../lib/utils";

export function SessionSelector() {
  const sessionKey = useChatStore((s) => s.sessionKey);
  const setSessionKey = useChatStore((s) => s.setSessionKey);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(sessionKey);

  const handleSave = () => {
    const trimmed = draft.trim();
    if (trimmed) {
      setSessionKey(trimmed);
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={handleSave}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSave();
            if (e.key === "Escape") setEditing(false);
          }}
          autoFocus
          className={cn(
            "h-6 px-2 text-xs rounded border bg-transparent",
            "border-purple-500/30 focus:border-purple-500 focus:outline-none",
            "w-32",
          )}
        />
      </div>
    );
  }

  return (
    <button
      onClick={() => {
        setDraft(sessionKey);
        setEditing(true);
      }}
      className={cn(
        "h-6 px-2 text-xs rounded-md",
        "bg-purple-500/10 text-purple-300 hover:bg-purple-500/20",
        "border border-purple-500/20",
        "transition-colors truncate max-w-[150px]",
      )}
      title={`Session: ${sessionKey}`}
    >
      {sessionKey}
    </button>
  );
}
