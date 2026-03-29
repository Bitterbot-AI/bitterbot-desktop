import { useRef, useCallback, useEffect } from "react";

export function FileEditor({
  content,
  lineCount,
  onContentChange,
  onSave,
  onExit,
}: {
  content: string;
  lineCount: number;
  onContentChange: (value: string) => void;
  onSave: () => void;
  onExit: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lineNumbersRef = useRef<HTMLDivElement>(null);

  const handleScroll = useCallback(() => {
    if (textareaRef.current && lineNumbersRef.current) {
      lineNumbersRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Ctrl+S / Cmd+S → save
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        onSave();
        return;
      }
      // Escape → exit edit mode
      if (e.key === "Escape") {
        e.preventDefault();
        onExit();
        return;
      }
      // Tab → insert 2 spaces
      if (e.key === "Tab") {
        e.preventDefault();
        const ta = e.currentTarget;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const val = ta.value;
        const newVal = val.substring(0, start) + "  " + val.substring(end);
        onContentChange(newVal);
        // Restore cursor position after React re-render
        requestAnimationFrame(() => {
          if (textareaRef.current) {
            textareaRef.current.selectionStart = start + 2;
            textareaRef.current.selectionEnd = start + 2;
          }
        });
      }
    },
    [onSave, onExit, onContentChange],
  );

  // Focus textarea on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const lines = content.split("\n");
  const actualLineCount = Math.max(lineCount, lines.length);

  return (
    <div className="flex flex-1 overflow-hidden bg-zinc-950/60">
      {/* Line numbers */}
      <div
        ref={lineNumbersRef}
        className="flex-shrink-0 py-3 pl-2 pr-1 select-none text-right font-mono text-[11px] leading-[1.45] text-zinc-600 overflow-hidden"
      >
        {Array.from({ length: actualLineCount }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      {/* Textarea */}
      <textarea
        ref={textareaRef}
        value={content}
        onChange={(e) => onContentChange(e.target.value)}
        onScroll={handleScroll}
        onKeyDown={handleKeyDown}
        spellCheck={false}
        className="flex-1 py-3 pr-3 pl-1 font-mono text-[11px] leading-[1.45] text-zinc-300 bg-transparent border-none outline-none resize-none whitespace-pre overflow-auto caret-purple-400"
      />
    </div>
  );
}
