import { useEffect, useState } from "react";
import { codeToHtml } from "shiki";

const MAX_HIGHLIGHT_SIZE = 100 * 1024; // 100KB

function useTheme() {
  const isDark = document.documentElement.classList.contains("dark");
  return { resolvedTheme: isDark ? "dark" : "light" };
}

export function SyntaxViewer({
  code,
  language,
  cachedHtml,
  onHighlighted,
}: {
  code: string;
  language: string;
  cachedHtml: string | null;
  onHighlighted: (html: string) => void;
}) {
  const { resolvedTheme } = useTheme();
  const [html, setHtml] = useState<string | null>(cachedHtml);
  const theme = resolvedTheme === "dark" ? "github-dark" : "github-light";
  const tooLarge = code.length > MAX_HIGHLIGHT_SIZE;

  useEffect(() => {
    if (cachedHtml) {
      setHtml(cachedHtml);
      return;
    }
    if (tooLarge || !code) {
      setHtml(null);
      return;
    }

    let cancelled = false;
    codeToHtml(code, {
      lang: language === "plaintext" ? "text" : language,
      theme,
      transformers: [
        {
          pre(node) {
            if (node.properties.style) {
              node.properties.style = (node.properties.style as string).replace(
                /background-color:[^;]+;?/g,
                "",
              );
            }
          },
        },
      ],
    })
      .then((result) => {
        if (!cancelled) {
          setHtml(result);
          onHighlighted(result);
        }
      })
      .catch(() => {
        if (!cancelled) setHtml(null);
      });

    return () => {
      cancelled = true;
    };
  }, [code, language, theme, cachedHtml, tooLarge, onHighlighted]);

  const lines = code.split("\n");

  if (html && !tooLarge) {
    return (
      <div className="flex flex-1 overflow-auto bg-zinc-950/60">
        {/* Line numbers */}
        <div className="flex-shrink-0 py-3 pl-2 pr-1 select-none text-right font-mono text-[11px] leading-[1.45] text-zinc-600">
          {lines.map((_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>
        {/* Highlighted code */}
        <div
          className="flex-1 overflow-x-auto py-3 pr-3 font-mono text-xs leading-[1.45] [&_pre]:!bg-transparent [&_pre]:!p-0 [&_pre]:!m-0 [&_code]:!text-[11px] [&_code]:!leading-[1.45]"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    );
  }

  // Fallback: plain text with line numbers
  return (
    <div className="flex flex-1 overflow-auto bg-zinc-950/60">
      <div className="flex-shrink-0 py-3 pl-2 pr-1 select-none text-right font-mono text-[11px] leading-[1.45] text-zinc-600">
        {lines.map((_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <pre className="flex-1 py-3 pr-3 font-mono text-[11px] leading-[1.45] text-zinc-300 whitespace-pre overflow-x-auto">
        {code}
      </pre>
    </div>
  );
}
