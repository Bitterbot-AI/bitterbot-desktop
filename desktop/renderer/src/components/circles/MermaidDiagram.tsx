import { useEffect, useState } from "react";

// Canvas diagram cards (cardType "mermaid"). Card text is PEER CONTENT — a
// hostile principal's string — so this renderer is deliberately paranoid:
//
//  - securityLevel "strict": labels HTML-escaped via mermaid's bundled
//    DOMPurify, no click handlers, no javascript: links.
//  - `secure` list extended (adversarial-pass find): strict does NOT protect
//    ordinary config keys, so an `%%{init:{"themeCSS":"...url(...)"}}%%`
//    directive could otherwise inject CSS with network beacons (a silent
//    read-receipt on merely opening the circle) or overlay the UI. Locking
//    themeCSS/themeVariables/fonts makes directives inert for those keys.
//  - suppressErrorRendering: a failed parse must throw BEFORE injecting its
//    error diagram, so the temp element is cleaned up (otherwise every
//    failing keystroke of the live preview leaks a div into document.body).
//  - renders are serialized through one promise chain: mermaid's config is a
//    mutable module global, so concurrent renders can bleed one card's
//    directive config into another card's draw.
//  - oversized input renders as escaped source, never through the parser.
//
// The library is dynamically imported so non-circle views never pay for it.

const MAX_DIAGRAM_CHARS = 20_000;

/** The full config is re-applied per render (initialize merges are not
 * trusted): the theme tracks the app's light/dark mode instead of the old
 * hardcoded "dark" that rendered dark-on-light in light mode (Phase D). */
function mermaidConfig(): Parameters<typeof import("mermaid").default.initialize>[0] {
  return {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme: document.documentElement.classList.contains("dark") ? "dark" : "default",
    fontFamily: "inherit",
    secure: [
      "secure",
      "securityLevel",
      "startOnLoad",
      "maxTextSize",
      "suppressErrorRendering",
      "maxEdges",
      "themeCSS",
      "themeVariables",
      "fontFamily",
      "altFontFamily",
    ],
  };
}

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;

function loadMermaid() {
  mermaidPromise ??= import("mermaid")
    .then((mod) => {
      mod.default.initialize(mermaidConfig());
      return mod.default;
    })
    .catch((err: unknown) => {
      // A transient chunk-load failure must not poison every future diagram.
      mermaidPromise = null;
      throw err;
    });
  return mermaidPromise;
}

/** mermaid.render ids must be unique per render and CSS-id safe. */
let renderSeq = 0;
/** Serialize renders: mermaid's config is module-global mutable state. */
let renderChain: Promise<unknown> = Promise.resolve();

function renderSerialized(code: string): Promise<string> {
  const run = renderChain
    .catch(() => {}) // a prior card's failure never blocks the queue
    .then(async () => {
      const mermaid = await loadMermaid();
      // Re-assert the FULL config every render: the serialized chain makes
      // this safe, a peer directive from a prior card can't bleed through,
      // and the theme picks up a mode toggle for the next render. (Already
      // rendered SVGs keep their theme until their card re-renders.)
      mermaid.initialize(mermaidConfig());
      const out = await mermaid.render(`circle-mmd-${++renderSeq}`, code);
      return out.svg;
    });
  renderChain = run;
  return run;
}

export function MermaidDiagram({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const oversized = code.length > MAX_DIAGRAM_CHARS;

  useEffect(() => {
    let alive = true;
    setSvg(null);
    setError(null);
    const trimmed = code.trim();
    if (!trimmed || trimmed.length > MAX_DIAGRAM_CHARS) return;
    void renderSerialized(trimmed)
      .then((rendered) => {
        if (alive) setSvg(rendered);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [code]);

  if (oversized || error) {
    return (
      <div className="text-xs">
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-muted-foreground">
          {code.slice(0, 4000)}
        </pre>
        <p className="mt-1 text-danger/80">
          {oversized
            ? "diagram source too large to render"
            : `diagram failed to render: ${(error ?? "").split("\n")[0]}`}
        </p>
      </div>
    );
  }
  if (!svg) {
    return <div className="text-xs text-muted-foreground py-2">rendering diagram…</div>;
  }
  return (
    <div
      className="overflow-x-auto [&_svg]:max-w-full [&_svg]:h-auto"
      // Output of mermaid strict mode over peer content with the secure list
      // extended and renders serialized — see the header comment.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
