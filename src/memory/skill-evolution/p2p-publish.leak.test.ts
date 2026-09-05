import { describe, expect, it } from "vitest";
import { findPublishLeak } from "./p2p-publish.js";

const CLEAN = `---
name: curl-timeout-guard
description: Use when a shell task calls curl against a remote host; not for local file reads.
---
Always pass --max-time 30 and retry once on a 5xx.
`;

describe("findPublishLeak (B7: private data never propagates)", () => {
  it("passes a clean SKILL.md", () => {
    expect(findPublishLeak(CLEAN)).toBeNull();
  });

  it("refuses bodies the secret redactor would change", () => {
    expect(
      findPublishLeak(`${CLEAN}\nexport OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456\n`),
    ).toMatch(/secret/);
    expect(
      findPublishLeak(`${CLEAN}\nAuthorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def\n`),
    ).toMatch(/secret/);
  });

  it("refuses user-specific identifiers: home paths, Windows profiles, emails, IPs", () => {
    expect(findPublishLeak(`${CLEAN}\nRead /home/victor/notes/todo.md first.\n`)).toMatch(
      /home-directory path/,
    );
    expect(findPublishLeak(`${CLEAN}\nOpen C:\\Users\\victor\\Desktop\\x.txt\n`)).toMatch(
      /Windows user-profile/,
    );
    expect(findPublishLeak(`${CLEAN}\nMail victor@example.com when done.\n`)).toMatch(
      /email address/,
    );
    expect(findPublishLeak(`${CLEAN}\nssh 192.168.1.20\n`)).toMatch(/IP address/);
  });
});
