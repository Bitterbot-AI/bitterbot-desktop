import type { Components } from "react-markdown";
import { CodeBlock, CodeBlockCode } from "../ui/code-block";
import { Markdown } from "../ui/markdown";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Phase A (readable timeline): circle messages render markdown like the rest
// of the Control UI — but through a RESTRICTED component map, because circle
// bodies are peer-authored content (the store keeps them security-wrapped for
// agent consumers; unwrapForDisplay strips the envelope for human eyes only).
//
// Restrictions vs the chat's default map:
//  - images never load (no remote fetches driven by peer content) — the alt
//    text/URL renders as inert text instead;
//  - headings demote to bold body text so a `#` can't shout across the room;
//  - raw HTML stays escaped (react-markdown default, no rehype-raw here);
//  - links keep the default URL sanitizer (http/https/mailto only) and open
//    externally with rel=noopener.

function extractLanguage(className?: string): string {
  const match = className?.match(/language-(\w+)/);
  return match?.[1] ?? "plaintext";
}

const CIRCLE_COMPONENTS: Partial<Components> = {
  p: ({ children, ...props }: any) => (
    <p className="my-0.5 whitespace-pre-wrap break-words" {...props}>
      {children}
    </p>
  ),
  a: ({ children, href, ...props }: any) => (
    <a
      href={href}
      className="text-circle-you underline-offset-2 hover:underline break-all"
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    >
      {children}
    </a>
  ),
  // Peer-driven image loads are a tracking pixel; show the reference, load nothing.
  img: ({ src, alt }: any) => (
    <span className="text-muted-foreground italic break-all">{alt || String(src ?? "")}</span>
  ),
  code: ({ className, children, ...props }: any) => {
    const isInline =
      !props.node?.position?.start.line ||
      props.node?.position?.start.line === props.node?.position?.end.line;
    if (isInline) {
      return <span className="bg-muted rounded-sm px-1 font-mono text-[0.85em]">{children}</span>;
    }
    return (
      <CodeBlock className="rounded-md overflow-hidden my-1.5 border max-w-full min-w-0 w-full">
        <CodeBlockCode
          code={children as string}
          language={extractLanguage(className)}
          className="text-xs"
        />
      </CodeBlock>
    );
  },
  pre: ({ children }: any) => <>{children}</>,
  ul: ({ children, ...props }: any) => (
    <ul className="list-disc pl-5 my-1" {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, ...props }: any) => (
    <ol className="list-decimal pl-5 my-1" {...props}>
      {children}
    </ol>
  ),
  li: ({ children, ...props }: any) => (
    <li className="my-0.5" {...props}>
      {children}
    </li>
  ),
  blockquote: ({ children, ...props }: any) => (
    <blockquote className="border-l-2 border-border pl-3 my-1 text-muted-foreground" {...props}>
      {children}
    </blockquote>
  ),
  // A chat row is not a document: headings read as emphasis, not banners.
  h1: ({ children }: any) => <p className="my-0.5 font-semibold">{children}</p>,
  h2: ({ children }: any) => <p className="my-0.5 font-semibold">{children}</p>,
  h3: ({ children }: any) => <p className="my-0.5 font-semibold">{children}</p>,
  h4: ({ children }: any) => <p className="my-0.5 font-semibold">{children}</p>,
  h5: ({ children }: any) => <p className="my-0.5 font-semibold">{children}</p>,
  h6: ({ children }: any) => <p className="my-0.5 font-semibold">{children}</p>,
  table: ({ children, ...props }: any) => (
    <div className="overflow-x-auto my-1.5">
      <table className="border-collapse text-xs" {...props}>
        {children}
      </table>
    </div>
  ),
  th: ({ children, ...props }: any) => (
    <th className="border border-border px-2 py-1 text-left font-semibold bg-muted/60" {...props}>
      {children}
    </th>
  ),
  td: ({ children, ...props }: any) => (
    <td className="border border-border px-2 py-1" {...props}>
      {children}
    </td>
  ),
};

export function CircleMarkdown({ text }: { text: string }) {
  return <Markdown components={CIRCLE_COMPONENTS}>{text}</Markdown>;
}
