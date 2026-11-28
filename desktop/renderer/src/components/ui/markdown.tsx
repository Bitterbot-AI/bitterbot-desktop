import { Check, Copy } from "lucide-react";
import { marked } from "marked";
import { memo, useId, useMemo, useState } from "react";
import ReactMarkdown, { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock, CodeBlockCode } from "@/components/ui/code-block";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { cn } from "@/lib/utils";

export type MarkdownProps = {
  children: string;
  id?: string;
  className?: string;
  components?: Partial<Components>;
};

function parseMarkdownIntoBlocks(markdown: string): string[] {
  const tokens = marked.lexer(markdown);
  return tokens.map((token: any) => token.raw);
}

/** Fence language from react-markdown's className (shared with CircleMarkdown). */
export function extractLanguage(className?: string): string {
  if (!className) return "plaintext";
  const match = className.match(/language-(\w+)/);
  return match?.[1] ?? "plaintext";
}

function CopyCodeButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be refused; the code is still selectable.
    }
  };
  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-ink-secondary transition-colors hover:bg-hover hover:text-ink"
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

const INITIAL_COMPONENTS: Partial<Components> = {
  code: function CodeComponent({ className, children, ...props }: any) {
    const isInline =
      !props.node?.position?.start.line ||
      props.node?.position?.start.line === props.node?.position?.end.line;

    if (isInline) {
      return (
        <span
          className={cn("rounded-sm bg-subtle px-1.5 py-0.5 font-mono text-code", className)}
          {...props}
        >
          {children}
        </span>
      );
    }

    const language = extractLanguage(className);

    const code = typeof children === "string" ? children.replace(/\n$/, "") : "";

    return (
      <div className="not-prose my-3 w-full min-w-0 max-w-full overflow-hidden rounded-md border border-line bg-subtle">
        <div className="flex h-9 items-center justify-between pl-4 pr-1 text-xs text-ink-secondary">
          <span>{language === "plaintext" ? "Text" : language}</span>
          <CopyCodeButton code={code} />
        </div>
        <CodeBlock className="w-full min-w-0 max-w-full">
          <CodeBlockCode code={code} language={language} className="text-code" />
        </CodeBlock>
      </div>
    );
  },
  pre: function PreComponent({ children }: any) {
    return <>{children}</>;
  },
  ul: function UnorderedList({ children, ...props }: any) {
    return (
      <ul className="list-disc pl-5 my-2" {...props}>
        {children}
      </ul>
    );
  },
  ol: function OrderedList({ children, ...props }: any) {
    return (
      <ol className="list-decimal pl-5 my-2" {...props}>
        {children}
      </ol>
    );
  },
  li: function ListItem({ children, ...props }: any) {
    return (
      <li className="my-1" {...props}>
        {children}
      </li>
    );
  },
  h1: function H1({ children, ...props }: any) {
    return (
      <h1 className="text-2xl font-bold my-3" {...props}>
        {children}
      </h1>
    );
  },
  h2: function H2({ children, ...props }: any) {
    return (
      <h2 className="text-xl font-bold my-2" {...props}>
        {children}
      </h2>
    );
  },
  h3: function H3({ children, ...props }: any) {
    return (
      <h3 className="text-lg font-bold my-2" {...props}>
        {children}
      </h3>
    );
  },
  blockquote: function Blockquote({ children, ...props }: any) {
    return (
      <blockquote
        className="border-l-4 border-muted pl-4 italic my-2 dark:text-muted-foreground dark:border-border"
        {...props}
      >
        {children}
      </blockquote>
    );
  },
  a: function Anchor({ children, href, ...props }: any) {
    return (
      <a
        href={href}
        className="text-primary hover:underline dark:text-info"
        target="_blank"
        rel="noopener noreferrer"
        {...props}
      >
        {children}
      </a>
    );
  },
  table: function Table({ children, ...props }: any) {
    return (
      <table className="w-full border-collapse my-3 text-sm" {...props}>
        {children}
      </table>
    );
  },
  th: function TableHeader({ children, ...props }: any) {
    return (
      <th
        className="border border-border dark:border-border px-3 py-2 text-left font-semibold bg-muted dark:bg-muted"
        {...props}
      >
        {children}
      </th>
    );
  },
  td: function TableCell({ children, ...props }: any) {
    return (
      <td className="border border-border dark:border-border px-3 py-2" {...props}>
        {children}
      </td>
    );
  },
};

const MemoizedMarkdownBlock = memo(
  function MarkdownBlock({
    content,
    components = INITIAL_COMPONENTS,
  }: {
    content: string;
    components?: Partial<Components>;
  }) {
    return (
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    );
  },
  function propsAreEqual(prevProps: any, nextProps: any) {
    return prevProps.content === nextProps.content;
  },
);

MemoizedMarkdownBlock.displayName = "MemoizedMarkdownBlock";

function MarkdownComponent({
  children,
  id,
  className,
  components = INITIAL_COMPONENTS,
}: MarkdownProps) {
  const generatedId = useId();
  const blockId = id ?? generatedId;
  const blocks = useMemo(() => parseMarkdownIntoBlocks(children), [children]);

  return (
    <div className={cn("prose-code:before:hidden prose-code:after:hidden", className)}>
      {blocks.map((block, index) => (
        <MemoizedMarkdownBlock
          key={`${blockId}-block-${index}`}
          content={block}
          components={components}
        />
      ))}
    </div>
  );
}

const Markdown = memo(MarkdownComponent);
Markdown.displayName = "Markdown";

export { Markdown };
