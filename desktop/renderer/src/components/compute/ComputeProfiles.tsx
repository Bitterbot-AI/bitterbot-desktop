import type { SoapboxSetupStatus } from "../../../../../src/infra/soapbox-setup-types";

export function ComputeProfiles({
  status,
  busy,
  add,
  select,
}: {
  status: SoapboxSetupStatus;
  busy: boolean;
  add: () => void;
  select: (id: string) => void;
}) {
  return (
    <div className="space-y-3">
      <h3 className="font-medium">Buyer and operator profiles</h3>
      <p className="text-sm text-muted-foreground">
        One profile is active at a time. Switching reconnects Compute and preserves your saved
        setup. Finish active jobs and pending payments first. Paid profiles use your separate Base
        Sepolia wallet.
      </p>
      {status.profiles?.map((profile) => (
        <div
          key={profile.id}
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
        >
          <span className="text-sm">
            {profile.name}
            {profile.active ? " · Active" : ""}
          </span>
          {!profile.active && (
            <button
              className="text-sm underline disabled:opacity-40"
              disabled={busy}
              onClick={() => select(profile.id)}
            >
              Switch to {profile.name}
            </button>
          )}
        </div>
      ))}
      <button
        className="rounded-lg bg-brand px-4 py-2 text-sm text-white disabled:opacity-40"
        disabled={busy}
        onClick={add}
      >
        Add buyer or operator profile
      </button>
    </div>
  );
}
