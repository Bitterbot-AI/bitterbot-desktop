// Canned gateway responses for the PLAN-65 screenshot harness.
//
// Nothing here is real data. The point is a stable, representative picture of
// each screen, so a restyle can be compared before and after. Add a method
// here when the harness reports it under "unanswered methods" and the view
// needs it to render something meaningful.

const NOW = Date.UTC(2026, 10, 27, 15, 0, 0);
const minutesAgo = (n) => NOW - n * 60_000;

export const DEMO_SESSION_KEY = "chat-demo-growth";

const sessions = [
  {
    key: DEMO_SESSION_KEY,
    derivedTitle: "Clone and download numbers, week 47",
    updatedAt: minutesAgo(4),
  },
  {
    key: "chat-demo-2",
    derivedTitle: "Draft the release notes for 1.15",
    updatedAt: minutesAgo(95),
  },
  {
    key: "chat-demo-3",
    derivedTitle: "Why did the nightly backup fail?",
    updatedAt: minutesAgo(60 * 26),
  },
  {
    key: "chat-demo-4",
    derivedTitle: "Plan a three day trip to Lisbon",
    updatedAt: minutesAgo(60 * 24 * 3),
  },
  {
    key: "chat-demo-5",
    derivedTitle: "Summarise the retrieval paper",
    updatedAt: minutesAgo(60 * 24 * 9),
  },
  {
    key: "chat-demo-6",
    derivedTitle: "Compare three standing desks",
    updatedAt: minutesAgo(60 * 24 * 20),
  },
].map((s) => ({ ...s, kind: "direct", label: undefined, sessionId: `sid-${s.key}` }));

const conversation = [
  {
    role: "user",
    timestamp: minutesAgo(6),
    content: "Here are our clone and download numbers for the last two weeks. What changed?",
  },
  {
    role: "assistant",
    timestamp: minutesAgo(5),
    content: [
      {
        type: "text",
        text: [
          "Downloads rose and clones fell. The short version:",
          "",
          "| Metric | Week 46 | Week 47 | Change |",
          "| --- | --- | --- | --- |",
          "| npm downloads | 1,204 | 1,612 | +34% |",
          "| Unique cloners | 88 | 71 | -19% |",
          "| Release page views | 430 | 655 | +52% |",
          "",
          "Two things explain most of it:",
          "",
          "1. **The 1.15.0 release** landed on Thursday. Installs through `npm` jumped that day and stayed up.",
          "2. **Fewer source builds.** People who used to clone and build now install the package.",
          "",
          "If you want the daily series, this reproduces it:",
          "",
          "```bash",
          "gh api repos/OWNER/REPO/traffic/clones --jq '.clones[] | [.timestamp, .uniques] | @tsv'",
          "```",
          "",
          "Want me to chart the two weeks side by side?",
        ].join("\n"),
      },
    ],
  },
  { role: "user", timestamp: minutesAgo(4), content: "Yes, and keep it to one chart." },
  {
    role: "assistant",
    timestamp: minutesAgo(4),
    content: [
      {
        type: "text",
        text: "Done. One chart, downloads as bars and unique cloners as a line, both on a daily axis. The crossover is on the release day.",
      },
    ],
  },
];

const models = [
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", provider: "anthropic", reasoning: true },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", provider: "anthropic" },
  { id: "gpt-5.4-mini", name: "GPT-5.4 mini", provider: "openai" },
];

/**
 * method -> payload, or (params) => payload.
 *
 * HELLO advertises exactly these methods, so components that check
 * `hello.features.methods` before calling (the usage strip, for one) stay
 * quiet instead of receiving an empty object in a shape they do not expect.
 */
export const RESPONSES = {
  "sessions.list": { sessions, count: sessions.length },
  "chat.history": (params) => ({
    sessionKey: params?.sessionKey,
    messages: params?.sessionKey === DEMO_SESSION_KEY ? conversation : [],
  }),
  "models.list": { models },
};

export const HELLO = {
  type: "hello-ok",
  protocol: 3,
  version: "0.0.0-screenshots",
  ts: NOW,
  features: { methods: Object.keys(RESPONSES), events: [] },
  auth: { role: "owner", scopes: ["operator.admin"] },
  policy: { tickIntervalMs: 30_000 },
  snapshot: {},
};
