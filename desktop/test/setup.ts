import * as React from "react";
import { vi } from "vitest";

// Monaco brings a heavy editor and uses APIs (web workers, pointer events,
// ResizeObserver) that happy-dom doesn't fully implement. Stub the editor as
// a plain textarea so SkillEditor can be exercised end-to-end without the
// real Monaco loader.
vi.mock("@monaco-editor/react", () => ({
  default: function MockEditor(props: {
    value?: string;
    onChange?: (v: string | undefined) => void;
  }) {
    return React.createElement("textarea", {
      "data-testid": "skill-editor-textarea",
      value: props.value ?? "",
      onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => props.onChange?.(e.target.value),
    });
  },
}));

// happy-dom doesn't ship ResizeObserver.
class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as unknown as { ResizeObserver: typeof MockResizeObserver }).ResizeObserver =
  MockResizeObserver;

// happy-dom doesn't implement window.confirm/alert. Default to "yes" so flows
// that prompt for confirmation (e.g. IncomingPanel.accept) proceed.
if (typeof globalThis.confirm !== "function") {
  (globalThis as { confirm: (msg?: string) => boolean }).confirm = () => true;
}
if (typeof globalThis.alert !== "function") {
  (globalThis as { alert: (msg?: string) => void }).alert = () => {};
}
