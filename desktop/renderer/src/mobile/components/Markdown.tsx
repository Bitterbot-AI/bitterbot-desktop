import { Check, Copy, ExternalLink } from "lucide-react";
import { marked } from "marked";
import { memo, useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../../lib/utils";

/**
 * Chat markdown for the phone. Safe by construction: react-markdown never
 * renders raw HTML (no rehype-raw), its default URL transform drops
 * `javascript:` and other unsafe schemes, and images are never fetched (a
 * remote image is a tracking pixel; the CSP blocks them anyway), they become
 * a link the owner can choose to open. Code blocks stay plain (no syntax
 * highlighter on a phone CPU) with a copy button.
 */

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // clipboard needs a secure context; nothing to do
    }
  };
  return (
    <div className="my-3 overflow-hidden rounded-xl border border-[var(--m-hairline)] bg-[var(--m-surface-strong)]">
      <div className="flex items-center justify-between pl-3.5 pr-1 border-b border-[var(--m-hairline)]">
        <span className="font-mono text-2xs text-muted-foreground">{language}</span>
        <button
          type="button"
          onClick={copy}
          className="m-touch m-press flex items-center justify-center gap-1.5 text-2xs text-muted-foreground"
          aria-label={copied ? "Copied" : "Copy code"}
        >
          {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
        </button>
      </div>
      <pre className="overflow-x-auto">
        <code className={`language-${language} font-mono`}>{code}</code>
      </pre>
    </div>
  );
}

const COMPONENTS: Partial<Components> = {
  code({ className, children, node }) {
    const text = String(children ?? "").replace(/\n$/, "");
    const multiline =
      node?.position?.start.line !== undefined &&
      node.position.start.line !== node.position.end.line;
    if (!multiline && !className) {
      return <code>{children}</code>;
    }
    const language = /language-([\w+-]+)/.exec(className ?? "")?.[1] ?? "text";
    return <CodeBlock code={text} language={language} />;
  },
  pre({ children }) {
    return <>{children}</>;
  },
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    );
  },
  img({ src, alt }) {
    const url = typeof src === "string" ? src : "";
    if (!url) return null;
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="inline-flex items-center gap-1"
      >
        <ExternalLink className="size-3.5" />
        {alt || "Open image"}
      </a>
    );
  },
};

const Block = memo(function Block({ source }: { source: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
      {source}
    </ReactMarkdown>
  );
});

/** Split into top-level blocks so a streaming reply re-renders only its tail. */
function splitBlocks(markdown: string): string[] {
  try {
    return marked.lexer(markdown).map((token) => token.raw);
  } catch {
    return [markdown];
  }
}

export function Markdown({
  children,
  className,
  streaming = false,
}: {
  children: string;
  className?: string;
  streaming?: boolean;
}) {
  const blocks = useMemo(() => splitBlocks(children), [children]);
  return (
    <div
      className={cn(
        "prose chat-markdown max-w-none text-foreground",
        streaming && "m-caret",
        className,
      )}
    >
      {blocks.map((block, i) => (
        <Block key={i} source={block} />
      ))}
    </div>
  );
}
