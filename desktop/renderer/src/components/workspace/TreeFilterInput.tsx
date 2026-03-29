import { Search, X } from "lucide-react";

export function TreeFilterInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-zinc-800/30">
      <Search className="w-3 h-3 text-zinc-500 flex-shrink-0" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Filter files..."
        className="flex-1 bg-transparent text-[11px] text-zinc-300 placeholder:text-zinc-600 border-none outline-none font-mono"
      />
      {value && (
        <button
          onClick={() => onChange("")}
          className="w-4 h-4 flex items-center justify-center rounded text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          <X className="w-2.5 h-2.5" />
        </button>
      )}
    </div>
  );
}
