/**
 * One setup step, rendered generically from what `wizard.next` returns
 * (PLAN-56 Phase 4). The gateway's step model (src/wizard/setup-steps.ts)
 * decides WHAT is asked; this view only knows prompt types (note, select,
 * confirm, text, multiselect), so a step added on the gateway shows up here
 * without a UI change. `data` adds rich detail for the first reply, the
 * doctor summary and the completion screen.
 */

import { useEffect, useMemo, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export type SetupStepOption = { value: unknown; label: string; hint?: string };

export type SetupStep = {
  id: string;
  type: "note" | "select" | "text" | "confirm" | "multiselect" | "progress" | "action";
  title?: string;
  message?: string;
  options?: SetupStepOption[];
  initialValue?: unknown;
  placeholder?: string;
  sensitive?: boolean;
  section?: { id: string; title: string; index: number; total: number };
  data?: unknown;
};

type FirstTurnData = {
  kind: "first-turn";
  ok?: boolean;
  skipped?: boolean;
  latencyMs?: number;
  reply?: string;
  model?: string;
  error?: string;
};
type DoctorData = {
  kind: "doctor";
  worstLevel: string;
  findings: Array<{ section: string; level: "ok" | "warn" | "error" | "info"; message: string }>;
};
type DoneData = { kind: "done"; channelsNext?: boolean; restart?: boolean };

const keyOf = (value: unknown) => JSON.stringify(value ?? null);

export function formatLatency(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function FirstTurnBlock({ data }: { data: FirstTurnData }) {
  if (data.skipped) {
    return null;
  }
  if (data.ok) {
    return (
      <div className="space-y-2" data-testid="setup-first-turn">
        <div className="rounded-md border bg-muted/40 p-3 text-sm whitespace-pre-wrap">
          {data.reply}
        </div>
        <p className="text-xs text-muted-foreground">
          First reply in{" "}
          <span className="font-medium text-foreground">{formatLatency(data.latencyMs ?? 0)}</span>
          {data.model ? ` from ${data.model}` : ""}.
        </p>
      </div>
    );
  }
  return (
    <div
      className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm whitespace-pre-wrap"
      data-testid="setup-first-turn-error"
    >
      {data.error}
    </div>
  );
}

const LEVEL_LABEL: Record<string, string> = {
  ok: "OK",
  info: "Info",
  warn: "Warning",
  error: "Problem",
};

function DoctorBlock({ data }: { data: DoctorData }) {
  const counts = { ok: 0, info: 0, warn: 0, error: 0 };
  for (const f of data.findings) {
    counts[f.level] += 1;
  }
  return (
    <div className="space-y-2" data-testid="setup-doctor">
      <p className="text-sm">
        {counts.ok} ok, {counts.warn} warning(s), {counts.error} problem(s)
      </p>
      <ul className="space-y-1 text-xs">
        {data.findings.map((f, i) => (
          <li
            key={`${f.section}-${i}`}
            className={
              f.level === "error"
                ? "text-destructive"
                : f.level === "warn"
                  ? "text-warning"
                  : "text-muted-foreground"
            }
          >
            <span className="font-medium">{LEVEL_LABEL[f.level] ?? f.level}</span> ({f.section}):{" "}
            {f.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SetupStepView({
  step,
  busy,
  onAnswer,
}: {
  step: SetupStep;
  busy: boolean;
  onAnswer: (value: unknown) => void;
}) {
  const data = step.data as FirstTurnData | DoctorData | DoneData | undefined;
  const options = useMemo(() => step.options ?? [], [step.options]);
  const [selected, setSelected] = useState<string>(() =>
    keyOf(step.initialValue ?? options[0]?.value),
  );
  const [text, setText] = useState(() =>
    typeof step.initialValue === "string" && !step.sensitive ? step.initialValue : "",
  );
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(Array.isArray(step.initialValue) ? step.initialValue.map(keyOf) : []),
  );

  // A new step resets the local inputs.
  useEffect(() => {
    setSelected(keyOf(step.initialValue ?? options[0]?.value));
    setText(typeof step.initialValue === "string" && !step.sensitive ? step.initialValue : "");
    setChecked(new Set(Array.isArray(step.initialValue) ? step.initialValue.map(keyOf) : []));
  }, [step.id, step.initialValue, step.sensitive, options]);

  const submitSelect = () => {
    const match = options.find((o) => keyOf(o.value) === selected);
    onAnswer(match ? match.value : options[0]?.value);
  };

  return (
    <div className="space-y-4" data-testid={`setup-step-${step.type}`}>
      {step.section ? (
        <p className="text-xs text-muted-foreground" data-testid="setup-section">
          Step {step.section.index} of {step.section.total}: {step.section.title}
        </p>
      ) : null}
      {step.title ? <h2 className="text-lg font-semibold">{step.title}</h2> : null}
      {step.message && data?.kind !== "first-turn" && data?.kind !== "doctor" ? (
        <p className="text-sm leading-relaxed whitespace-pre-wrap">{step.message}</p>
      ) : null}
      {data?.kind === "first-turn" ? (
        (data as FirstTurnData).skipped ? (
          <p className="text-sm leading-relaxed whitespace-pre-wrap">{step.message}</p>
        ) : (
          <FirstTurnBlock data={data as FirstTurnData} />
        )
      ) : null}
      {data?.kind === "doctor" ? <DoctorBlock data={data as DoctorData} /> : null}

      {step.type === "select" ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            submitSelect();
          }}
        >
          <div role="radiogroup" aria-label={step.title ?? "Choose one"} className="space-y-2">
            {options.map((option) => {
              const key = keyOf(option.value);
              return (
                <label
                  key={key}
                  className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm ${
                    selected === key ? "border-primary bg-primary/5" : ""
                  }`}
                >
                  <input
                    type="radio"
                    name={`setup-${step.id}`}
                    className="mt-1"
                    checked={selected === key}
                    onChange={() => setSelected(key)}
                  />
                  <span>
                    <span className="font-medium">{option.label}</span>
                    {option.hint ? (
                      <span className="block text-xs text-muted-foreground">{option.hint}</span>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </div>
          <Button type="submit" disabled={busy}>
            Continue
          </Button>
        </form>
      ) : null}

      {step.type === "multiselect" ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            onAnswer(options.filter((o) => checked.has(keyOf(o.value))).map((o) => o.value));
          }}
        >
          {options.map((option) => {
            const key = keyOf(option.value);
            return (
              <label key={key} className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={checked.has(key)}
                  onChange={(e) => {
                    const next = new Set(checked);
                    if (e.target.checked) {
                      next.add(key);
                    } else {
                      next.delete(key);
                    }
                    setChecked(next);
                  }}
                />
                <span>{option.label}</span>
              </label>
            );
          })}
          <Button type="submit" disabled={busy}>
            Continue
          </Button>
        </form>
      ) : null}

      {step.type === "text" ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            onAnswer(text);
            // A secret leaves the page's state as soon as it is sent.
            if (step.sensitive) {
              setText("");
            }
          }}
        >
          <Input
            aria-label={step.message ?? "Value"}
            type={step.sensitive ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            placeholder={step.placeholder}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <Button type="submit" disabled={busy}>
            Continue
          </Button>
        </form>
      ) : null}

      {step.type === "confirm" ? (
        <div className="flex gap-2">
          <Button disabled={busy} onClick={() => onAnswer(true)}>
            Yes
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => onAnswer(false)}>
            No
          </Button>
        </div>
      ) : null}

      {step.type === "note" || step.type === "progress" || step.type === "action" ? (
        <Button disabled={busy} onClick={() => onAnswer(null)}>
          {data?.kind === "done" ? "Finish" : "Continue"}
        </Button>
      ) : null}
    </div>
  );
}
