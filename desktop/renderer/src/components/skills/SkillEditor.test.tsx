import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillEditor } from "./SkillEditor";

const requestMock = vi.fn();

vi.mock("../../stores/gateway-store", () => ({
  useGatewayStore: (selector: (state: unknown) => unknown) =>
    selector({
      request: requestMock,
      status: "connected",
      subscribe: () => () => {},
    }),
}));

describe("SkillEditor", () => {
  beforeEach(() => {
    requestMock.mockReset();
    requestMock.mockResolvedValue({ ok: true });
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("rejects content without YAML frontmatter", async () => {
    render(<SkillEditor onClose={() => {}} />);
    const textarea = screen.getByTestId("skill-editor-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "# no frontmatter here" } });
    await waitFor(() => {
      expect(screen.getByText(/must start with YAML frontmatter/i)).toBeTruthy();
    });
  });

  it("rejects names that don't match the slug pattern", async () => {
    render(<SkillEditor onClose={() => {}} />);
    const textarea = screen.getByTestId("skill-editor-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: {
        value: "---\nname: Bad_Name\ndescription: hello there\n---\n\n## When to use\n\nDo it.",
      },
    });
    await waitFor(() => {
      expect(screen.getByText(/lowercase letters, digits, and hyphens/i)).toBeTruthy();
    });
  });

  it("submits via skills.create when valid", async () => {
    const onClose = vi.fn();
    render(<SkillEditor onClose={onClose} />);
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("my-skill"), "good-skill");
    const textarea = screen.getByTestId("skill-editor-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: {
        value:
          "---\nname: good-skill\ndescription: A real description that says something useful here.\n---\n\n## When to use\n\nWhen you actually need this skill\n",
      },
    });
    await user.click(screen.getByRole("button", { name: /save skill/i }));
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith(
        "skills.create",
        expect.objectContaining({ name: "good-skill", target: "managed" }),
      );
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("persists drafts to localStorage and restores them on remount", async () => {
    const { unmount } = render(<SkillEditor onClose={() => {}} />);
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("my-skill"), "drafted-skill");
    const textarea = screen.getByTestId("skill-editor-textarea") as HTMLTextAreaElement;
    const draftContent =
      "---\nname: drafted-skill\ndescription: my draft is here.\n---\n\n## When to use\n\nLater.\n";
    fireEvent.change(textarea, { target: { value: draftContent } });
    await waitFor(() => {
      expect(localStorage.getItem("bitterbot.skill-editor.draft.drafted-skill")).toBe(draftContent);
    });
    unmount();

    render(<SkillEditor onClose={() => {}} />);
    await user.type(screen.getByPlaceholderText("my-skill"), "drafted-skill");
    await waitFor(() => {
      const next = screen.getByTestId("skill-editor-textarea") as HTMLTextAreaElement;
      expect(next.value).toBe(draftContent);
    });
    expect(screen.getByText(/draft restored/i)).toBeTruthy();
  });
});
