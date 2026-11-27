/**
 * PLAN-64 Phase 3: the Practices section of the Memory page. Under test:
 * what each practice shows (text, scope in words, status, saved date,
 * counters, the owner's evidence line), every action and the RPC it calls
 * (confirm, decline, edit, re-scope, retire, bring back, add, merge task
 * types), the optimistic update and its roll-back, the empty state, a read
 * refused for a missing scope, and an older gateway without the method.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatDate } from "../../lib/format";
import {
  describePracticeScope,
  describePracticeStatus,
  PracticesSection,
  type PracticeRow,
  type TaskTypeRow,
} from "./PracticesSection";

const requestMock = vi.fn();
const toastError = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());

vi.mock("../../stores/gateway-store", () => ({
  useGatewayStore: (selector: (state: unknown) => unknown) =>
    selector({ request: requestMock, status: "connected" }),
}));
vi.mock("sonner", () => ({ toast: { error: toastError, success: toastSuccess } }));

const SAVED_AT = Date.UTC(2026, 10, 12, 10, 0, 0);

const npm: PracticeRow = {
  id: "p-npm",
  statement: "Include npm downloads",
  scope: "task:repo-stats",
  scopeLabel: "repo stats",
  status: "active",
  createdAt: SAVED_AT - 1000,
  savedAt: SAVED_AT,
  counts: { applied: 5, repeats: 1 },
  evidence: [
    { ref: "session:/s/a.jsonl#L3", text: "how about our npm downloads" },
    { ref: "session:/s/b.jsonl#L9", text: null },
  ],
};
const candidate: PracticeRow = {
  id: "p-prs",
  statement: "Include open pull requests",
  scope: "task:repo-stats",
  scopeLabel: "repo stats",
  status: "candidate",
  createdAt: SAVED_AT,
  savedAt: SAVED_AT,
  counts: { applied: 0, repeats: 0 },
  evidence: [],
};
const short: PracticeRow = {
  id: "p-short",
  statement: "Keep answers under ten lines",
  scope: "global",
  scopeLabel: "everything",
  status: "retired",
  createdAt: SAVED_AT,
  savedAt: SAVED_AT,
  counts: { applied: 2, repeats: 0 },
  evidence: [],
};
const declined: PracticeRow = {
  id: "p-weather",
  statement: "Add the weather forecast",
  scope: "task:repo-stats",
  scopeLabel: "repo stats",
  status: "suppressed",
  createdAt: SAVED_AT,
  savedAt: SAVED_AT,
  counts: { applied: 0, repeats: 0 },
  evidence: [],
};
const taskTypes: TaskTypeRow[] = [
  { slug: "repo-stats", label: "repo stats", occurrences: 53, recurring: true, example: null },
  { slug: "npm-numbers", label: "npm numbers", occurrences: 4, recurring: true, example: null },
  {
    slug: "weather-lisbon",
    label: "",
    occurrences: 1,
    recurring: false,
    example: "What is the weather in Lisbon?",
  },
];

let listed: {
  practices: PracticeRow[];
  taskTypes: TaskTypeRow[];
  activeProject: string | null;
  jobs?: Array<{ scope: string; name: string }>;
};
let failing: Record<string, Error>;

beforeEach(() => {
  toastError.mockReset();
  toastSuccess.mockReset();
  listed = { practices: [npm, candidate, short, declined], taskTypes, activeProject: "acme" };
  failing = {};
  requestMock.mockReset();
  requestMock.mockImplementation(async (method: string) => {
    if (failing[method]) throw failing[method];
    switch (method) {
      case "memory.practices":
        return listed;
      case "memory.retirePractice":
      case "memory.unretirePractice":
      case "memory.answerPracticeOffer":
        return { ok: true };
      case "memory.editPractice":
      case "memory.setPracticeScope":
      case "memory.savePractice":
        return { ok: true, op: "strengthen" };
      case "memory.mergeTaskTypes":
        return { ok: true };
      default:
        throw new Error(`unexpected ${method}`);
    }
  });
});

const card = (id: string) => within(screen.getByTestId(`practice-${id}`));

describe("describePracticeScope / describePracticeStatus", () => {
  it("puts a scope and a status in plain words", () => {
    expect(describePracticeScope({ scope: "global", scopeLabel: "everything" })).toBe("Everywhere");
    expect(describePracticeScope({ scope: "task:repo-stats", scopeLabel: "repo stats" })).toBe(
      "For repo stats",
    );
    // An older gateway sends no label: the slug is read as words, never shown raw.
    expect(describePracticeScope({ scope: "task:repo-stats" })).toBe("For repo stats");
    expect(describePracticeScope({ scope: "project:acme" })).toBe("For project acme");
    expect(describePracticeScope({ scope: "job:abc-123" })).toBe("For one scheduled job");
    // PLAN-64 Phase 5: the gateway sends the job's name (its id when the job is gone).
    expect(describePracticeScope({ scope: "job:abc-123", scopeLabel: "Repo traffic" })).toBe(
      "For the scheduled job Repo traffic",
    );
    expect(describePracticeStatus("candidate")).toBe("Waiting for your answer");
    expect(describePracticeStatus("suppressed")).toBe("Declined");
  });
});

describe("PracticesSection", () => {
  it("lists each practice with scope, status, saved date, counters and the evidence line", async () => {
    render(<PracticesSection />);
    await screen.findByText("Include npm downloads");
    expect(requestMock).toHaveBeenCalledWith("memory.practices", {
      includePendingTaskTypes: true,
    });
    const active = card("p-npm");
    // The chip, not the option of the same name in the scope select.
    expect(active.getByText("For repo stats", { selector: "span" })).toBeTruthy();
    expect(active.getByText("Active")).toBeTruthy();
    expect(active.getByText(new RegExp(`Saved ${formatDate(SAVED_AT)}`))).toBeTruthy();
    expect(active.getByText("given to your agent 5 times")).toBeTruthy();
    expect(active.getByText("repeated by you once")).toBeTruthy();
    expect(active.getByText('You said: "how about our npm downloads"')).toBeTruthy();
    // An evidence ref whose line could not be read is not shown.
    expect(active.queryByText(/b\.jsonl/)).toBeNull();
    expect(card("p-prs").getByText("Waiting for your answer")).toBeTruthy();
    expect(card("p-short").getByText("Everywhere", { selector: "span" })).toBeTruthy();
    expect(card("p-short").getByText("Retired")).toBeTruthy();
    expect(card("p-weather").getByText("Declined")).toBeTruthy();
    // No raw scope strings on the page.
    expect(screen.queryByText(/task:repo-stats/)).toBeNull();
    // Candidates come first.
    const ids = screen.getAllByTestId(/^practice-/).map((el) => el.getAttribute("data-testid"));
    expect(ids).toEqual([
      "practice-p-prs",
      "practice-p-npm",
      "practice-p-short",
      "practice-p-weather",
    ]);
  });

  it("confirms a candidate through memory.answerPracticeOffer and shows it as active", async () => {
    render(<PracticesSection />);
    await screen.findByText("Include open pull requests");
    await userEvent.setup().click(card("p-prs").getByText("Yes, every time"));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("memory.answerPracticeOffer", {
        id: "p-prs",
        answer: "yes",
      }),
    );
    await waitFor(() => expect(card("p-prs").getByText("Active")).toBeTruthy());
    expect(card("p-prs").queryByText("Yes, every time")).toBeNull();
  });

  it("declines a candidate", async () => {
    render(<PracticesSection />);
    await screen.findByText("Include open pull requests");
    await userEvent.setup().click(card("p-prs").getByText("No"));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("memory.answerPracticeOffer", {
        id: "p-prs",
        answer: "no",
      }),
    );
    await waitFor(() => expect(card("p-prs").getByText("Declined")).toBeTruthy());
    expect(card("p-prs").getByText("Bring back")).toBeTruthy();
  });

  it("edits the statement through memory.editPractice", async () => {
    const user = userEvent.setup();
    render(<PracticesSection />);
    await screen.findByText("Include npm downloads");
    await user.click(card("p-npm").getByText("Edit"));
    const box = card("p-npm").getByLabelText("Practice text");
    await user.clear(box);
    await user.type(box, "Include npm downloads per day");
    await user.click(card("p-npm").getByText("Save"));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("memory.editPractice", {
        id: "p-npm",
        statement: "Include npm downloads per day",
      }),
    );
    await waitFor(() =>
      expect(card("p-npm").getByText("Include npm downloads per day")).toBeTruthy(),
    );
  });

  it("offers everywhere, each recurring task type and the project as scopes, and re-scopes", async () => {
    const user = userEvent.setup();
    render(<PracticesSection />);
    await screen.findByText("Include npm downloads");
    const select = card("p-npm").getByLabelText(
      'Where "Include npm downloads" applies',
    ) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => [o.value, o.textContent])).toEqual([
      ["global", "Everywhere"],
      ["task:repo-stats", "For repo stats"],
      ["task:npm-numbers", "For npm numbers"],
      ["project:acme", "For project acme"],
    ]);
    expect(select.value).toBe("task:repo-stats");
    // What the gateway lists after the change (the section reloads for the label).
    listed = {
      ...listed,
      practices: [
        { ...npm, scope: "global", scopeLabel: "everything" },
        candidate,
        short,
        declined,
      ],
    };
    await user.selectOptions(select, "global");
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("memory.setPracticeScope", {
        id: "p-npm",
        scope: "global",
      }),
    );
    await waitFor(() =>
      expect(card("p-npm").getByText("Everywhere", { selector: "span" })).toBeTruthy(),
    );
  });

  it("PLAN-64 Phase 5: shows a job practice by its job, offers the scheduled jobs as scopes, and shows the not-followed count", async () => {
    const user = userEvent.setup();
    const jobPractice: PracticeRow = {
      id: "p-job",
      statement: "Include the unique counts",
      scope: "job:cron_traffic1",
      scopeLabel: "Repo traffic",
      status: "active",
      createdAt: SAVED_AT,
      savedAt: SAVED_AT,
      counts: { applied: 3, repeats: 0, notFollowed: 2 },
      evidence: [],
    };
    const orphan: PracticeRow = {
      ...jobPractice,
      id: "p-orphan",
      statement: "Include the top referrers",
      scope: "job:cron_deleted",
      scopeLabel: "cron_deleted",
      counts: { applied: 0, repeats: 0, notFollowed: 0 },
    };
    listed = {
      ...listed,
      practices: [npm, jobPractice, orphan],
      jobs: [{ scope: "job:cron_traffic1", name: "Repo traffic" }],
    };
    render(<PracticesSection />);
    await screen.findByText("Include the unique counts");
    expect(
      card("p-job").getByText("For the scheduled job Repo traffic", { selector: "span" }),
    ).toBeTruthy();
    expect(card("p-job").getByText(/not in the answer/).textContent).toContain("2");
    expect(card("p-npm").queryByText(/not in the answer/)).toBeNull();
    // A practice of a deleted job keeps its scope in the list, named by the id.
    const orphanSelect = card("p-orphan").getByLabelText(
      'Where "Include the top referrers" applies',
    ) as HTMLSelectElement;
    expect(Array.from(orphanSelect.options).map((o) => [o.value, o.textContent])).toEqual([
      ["global", "Everywhere"],
      ["task:repo-stats", "For repo stats"],
      ["task:npm-numbers", "For npm numbers"],
      ["project:acme", "For project acme"],
      ["job:cron_traffic1", "For the scheduled job Repo traffic"],
      ["job:cron_deleted", "For the scheduled job cron_deleted"],
    ]);
    // A task practice can be moved to a scheduled job.
    const select = card("p-npm").getByLabelText(
      'Where "Include npm downloads" applies',
    ) as HTMLSelectElement;
    await user.selectOptions(select, "job:cron_traffic1");
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("memory.setPracticeScope", {
        id: "p-npm",
        scope: "job:cron_traffic1",
      }),
    );
  });

  it("retires after a confirmation and brings a retired practice back", async () => {
    const user = userEvent.setup();
    render(<PracticesSection />);
    await screen.findByText("Include npm downloads");
    await user.click(card("p-npm").getByText("Retire"));
    // Nothing is sent until the dialog is confirmed.
    expect(requestMock).not.toHaveBeenCalledWith("memory.retirePractice", expect.anything());
    await user.click(await screen.findByRole("button", { name: "Retire" }));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("memory.retirePractice", { id: "p-npm" }),
    );
    await waitFor(() => expect(card("p-npm").getByText("Retired")).toBeTruthy());

    await user.click(card("p-short").getByText("Bring back"));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("memory.unretirePractice", { id: "p-short" }),
    );
    await waitFor(() => expect(card("p-short").getByText("Active")).toBeTruthy());
  });

  it("adds a practice by hand at the chosen scope and reloads", async () => {
    const user = userEvent.setup();
    render(<PracticesSection />);
    await screen.findByText("Include npm downloads");
    await user.type(screen.getByLabelText("New practice"), "Give the numbers first");
    await user.selectOptions(
      screen.getByLabelText("Where the new practice applies"),
      "task:repo-stats",
    );
    await user.click(screen.getByText("Add"));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("memory.savePractice", {
        statement: "Give the numbers first",
        scope: "task:repo-stats",
      }),
    );
    await waitFor(() =>
      expect(requestMock.mock.calls.filter(([m]) => m === "memory.practices")).toHaveLength(2),
    );
    expect((screen.getByLabelText("New practice") as HTMLInputElement).value).toBe("");
  });

  it("lists task types with occurrences and the recurring flag, and merges two", async () => {
    const user = userEvent.setup();
    render(<PracticesSection />);
    const types = within(await screen.findByTestId("task-types"));
    expect(types.getByText("asked 53 times")).toBeTruthy();
    expect(types.getAllByText("Recurring")).toHaveLength(2);
    // The ones that are not recurring yet are behind a toggle, named by a request.
    expect(types.queryByText("What is the weather in Lisbon?")).toBeNull();
    await user.click(types.getByText("Show 1 not recurring yet"));
    expect(types.getByText("What is the weather in Lisbon?")).toBeTruthy();
    expect(types.getByText("Not recurring yet")).toBeTruthy();

    await user.click(types.getAllByText("Merge into another")[1]!);
    await user.selectOptions(types.getByLabelText("Merge npm numbers into"), "repo-stats");
    await user.click(types.getByText("Merge"));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("memory.mergeTaskTypes", {
        from: "npm-numbers",
        into: "repo-stats",
      }),
    );
    expect(toastSuccess).toHaveBeenCalledWith("Task types merged");
  });

  it("explains in one sentence how practices get created when there are none", async () => {
    listed = { practices: [], taskTypes: [], activeProject: null };
    render(<PracticesSection />);
    expect(
      await screen.findByText(
        /No practices yet: one is saved when you tell your agent how to do a kind of task/,
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("task-types")).toBeNull();
    // Still possible to add one by hand.
    expect(screen.getByLabelText("New practice")).toBeTruthy();
  });

  it("puts the list back and says why when a change is refused for a missing scope", async () => {
    failing["memory.retirePractice"] = new Error("missing scope: operator.admin");
    const user = userEvent.setup();
    render(<PracticesSection />);
    await screen.findByText("Include npm downloads");
    await user.click(card("p-npm").getByText("Retire"));
    await user.click(await screen.findByRole("button", { name: "Retire" }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Could not retire it", {
        description: expect.stringContaining("not allowed to change them"),
      }),
    );
    expect(card("p-npm").getByText("Active")).toBeTruthy();
  });

  it("puts the list back when the gateway answers ok: false", async () => {
    requestMock.mockImplementation(async (method: string) =>
      method === "memory.practices" ? listed : { ok: false },
    );
    render(<PracticesSection />);
    await screen.findByText("Add the weather forecast");
    await userEvent.setup().click(card("p-weather").getByText("Bring back"));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(card("p-weather").getByText("Declined")).toBeTruthy();
  });

  it("says so when the session may not read practices", async () => {
    failing["memory.practices"] = new Error("missing scope: operator.read");
    render(<PracticesSection />);
    expect(await screen.findByText("This session is not allowed to read practices.")).toBeTruthy();
    expect(screen.queryByLabelText("New practice")).toBeNull();
  });

  it("renders nothing on a gateway without the method", async () => {
    failing["memory.practices"] = new Error("unknown method: memory.practices");
    const { container } = render(<PracticesSection />);
    await waitFor(() => expect(requestMock).toHaveBeenCalled());
    expect(container.querySelector("[data-testid='practices-section']")).toBeNull();
  });
});
