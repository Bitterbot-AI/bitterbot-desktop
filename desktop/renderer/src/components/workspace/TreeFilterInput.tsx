import { Search, X } from "lucide-react";

export function TreeFilterInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border/30">
      <Search className="w-3 h-3 text-muted-foreground flex-shrink-0" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Filter files..."
        className="flex-1 bg-transparent text-2xs text-foreground placeholder:text-muted-foreground border-none outline-none font-mono"
      />
      {value && (
        <button
          onClick={() => onChange("")}
          className="w-4 h-4 flex items-center justify-center rounded text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="w-2.5 h-2.5" />
        </button>
      )}
    </div>
  );
}
