// PLAN-36 UX: inbound circle messages are STORED wrapped as untrusted external
// content (security warning + <<<EXTERNAL_UNTRUSTED_CONTENT>>> envelope) — that
// wrap is for LLM consumers and must stay in the DB and on every agent-facing
// path. Humans shouldn't read the plumbing, so the chat UI unwraps for DISPLAY
// only and shows a small screened indicator instead. Fails open: anything that
// doesn't parse as a wrap renders untouched (never hide content).

const START = "<<<EXTERNAL_UNTRUSTED_CONTENT>>>";
const END = "<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>";

export function unwrapForDisplay(content: string): { text: string; wasWrapped: boolean } {
  const s = content.indexOf(START);
  const e = content.lastIndexOf(END);
  if (s < 0 || e < 0 || e <= s) {
    return { text: content, wasWrapped: false };
  }
  const inner = content.slice(s + START.length, e);
  // Drop the metadata header (Source:/From:/Subject:) up to its "---" divider.
  const divider = inner.indexOf("\n---\n");
  const body = divider >= 0 ? inner.slice(divider + "\n---\n".length) : inner;
  return { text: body.trim(), wasWrapped: true };
}
