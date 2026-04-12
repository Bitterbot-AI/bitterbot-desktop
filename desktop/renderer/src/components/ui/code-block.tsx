"use client";

import React, { useEffect, useState } from "react";
import { codeToHtml } from "shiki";
import { cn } from "@/lib/utils";
// Desktop: simple dark mode detection instead of next-themes
function useTheme() {
  const isDark = document.documentElement.classList.contains("dark");
  return { resolvedTheme: isDark ? "dark" : "light" };
}

export type CodeBlockProps = {
  children?: React.ReactNode;
  className?: string;
} & React.HTMLProps<HTMLDivElement>;

function CodeBlock({ children, className, ...props }: CodeBlockProps) {
  return (
    <div className={cn("w-px flex-grow min-w-0 overflow-hidden flex", className)} {...props}>
      {children}
    </div>
  );
}

export type CodeBlockCodeProps = {
  code: string;
  language?: string;
  theme?: string;
  className?: string;
} & React.HTMLProps<HTMLDivElement>;

function CodeBlockCode({
  code,
  language = "tsx",
  theme: propTheme,
  className,
  ...props
}: CodeBlockCodeProps) {
  const { resolvedTheme } = useTheme();
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);

  // Use github-dark when in dark mode, github-light when in light mode
  const theme = propTheme || (resolvedTheme === "dark" ? "github-dark" : "github-light");

  useEffect(() => {
    async function highlight() {
      if (!code || typeof code !== "string") {
        setHighlightedHtml(null);
        return;
      }
      const html = await codeToHtml(code, {
        lang: language,
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
      });
      setHighlightedHtml(html);
    }
    highlight();
  }, [code, language, theme]);

  const classNames = cn(
    "[&_pre]:!bg-background/95 [&_pre]:rounded-lg [&_pre]:p-4 [&_pre]:!overflow-x-auto [&_pre]:!w-px [&_pre]:!flex-grow [&_pre]:!min-w-0 [&_pre]:!box-border [&_.shiki]:!overflow-x-auto [&_.shiki]:!w-px [&_.shiki]:!flex-grow [&_.shiki]:!min-w-0 [&_code]:!min-w-0 [&_code]:!whitespace-pre",
    "w-px flex-grow min-w-0 overflow-hidden flex w-full",
    className,
  );

  // SSR fallback: render plain code if not hydrated yet
  return highlightedHtml ? (
    <div className={classNames} dangerouslySetInnerHTML={{ __html: highlightedHtml }} {...props} />
  ) : (
    <div className={classNames} {...props}>
      <pre className="!overflow-x-auto !w-px !flex-grow !min-w-0 !box-border">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export type CodeBlockGroupProps = React.HTMLAttributes<HTMLDivElement>;

function CodeBlockGroup({ children, className, ...props }: CodeBlockGroupProps) {
  return (
    <div className={cn("", className)} {...props}>
      {children}
    </div>
  );
}

export { CodeBlockGroup, CodeBlockCode, CodeBlock };
