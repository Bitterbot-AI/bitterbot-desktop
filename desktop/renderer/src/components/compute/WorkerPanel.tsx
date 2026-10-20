import type { SoapboxStatus } from "../../../../../src/infra/soapbox-client";

export function WorkerPanel({
  snapshot,
  busy,
  pause,
}: {
  snapshot: SoapboxStatus;
  busy: boolean;
  pause: (id: string, paused: boolean) => void;
}) {
  return (
    <div className="rounded-xl border border-border p-5 space-y-3">
      <h2 className="font-medium">Participating workers</h2>
      {!snapshot.nodes?.length && (
        <p className="text-sm text-muted-foreground">No eligible workers have registered yet.</p>
      )}
      {snapshot.nodes?.map((node) => (
        <div key={node.id} className="rounded-lg bg-muted/30 p-3 space-y-1">
          <div className="flex justify-between gap-2">
            <span className="font-medium text-sm">{node.id}</span>
            <span className="text-xs">
              {node.online ? "Online" : "Offline"}
              {node.operator_paused || node.offer.paused ? " · Paused" : ""}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {node.offer.cpu_threads} CPU slot · {node.offer.memory_mib} MiB RAM allowance
          </p>
          <p className="text-xs text-muted-foreground">
            {node.offer.isolation === "docker_v1"
              ? "Isolated jobs · network disabled"
              : "Shared host · development only"}
          </p>
          {node.offer.hardware?.map((gpu) => (
            <p key={gpu.uuid} className="text-xs">
              {gpu.name} · {gpu.memory_free_mib} / {gpu.memory_total_mib} MiB free ·{" "}
              {gpu.temperature_c}°C · {gpu.utilization_pct}% busy
            </p>
          ))}
          {node.offer.runtime && (
            <p className="text-xs">
              {node.offer.runtime.model} · Ollama {node.offer.runtime.version} ·{" "}
              {node.offer.gpu_observed
                ? node.offer.isolation === "docker_v1"
                  ? "GPU probe passed"
                  : "Fully GPU resident"
                : "GPU unavailable"}
            </p>
          )}
          {node.offer.gpu_unavailable_reason && (
            <p className="text-xs text-warning">GPU waiting: {node.offer.gpu_unavailable_reason}</p>
          )}
          <p className="text-xs text-muted-foreground">
            {node.offer.modes.join(" / ")} · worker-reported measurements
          </p>
          {(snapshot.principal?.roles.includes("admin") ||
            (snapshot.principal?.id === node.id &&
              snapshot.principal.roles.includes("worker"))) && (
            <button
              className="text-xs underline"
              disabled={busy}
              onClick={() => pause(node.id, !node.operator_paused)}
            >
              {node.operator_paused ? "Resume new work" : "Pause new work"}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
