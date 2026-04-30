---
summary: "OpenTelemetry tracing for gateway, agents, memory, and long-horizon runs"
read_when:
  - Wiring Bitterbot to Tempo, Jaeger, Honeycomb, or Datadog
  - Debugging slow tool calls or memory queries in production
  - Understanding the span hierarchy a long agent run produces
title: "Observability"
---

# Observability

Bitterbot emits OpenTelemetry traces from the gateway, agent runtime,
memory subsystem, and long-horizon runner. When a collector endpoint
is set, every gateway RPC, every tool execution, every memory search,
every dream pass, and every work-rest-dream cycle becomes a span
visible in any OTLP-compatible backend (Tempo, Jaeger, Honeycomb,
Datadog, New Relic, etc.).

When **no** collector endpoint is set, the entire OTel SDK stays
unloaded and `withSpan` is a zero-overhead no-op. There is no in-tree
fallback exporter and no opt-out flag — absence of config = disabled.

## Quickstart

### Local Jaeger (zero infrastructure)

```bash
# 1. Run a Jaeger all-in-one container
docker run -d --name jaeger \
  -p 4318:4318 -p 16686:16686 \
  jaegertracing/jaeger:latest

# 2. Point Bitterbot at it and start the gateway
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_SERVICE_NAME=bitterbot-gateway
pnpm start gateway

# 3. Open the Jaeger UI
open http://localhost:16686
```

### Honeycomb / Datadog / Tempo

These are all OTLP/HTTP-compatible. Set their endpoint and (where
needed) their auth header:

```bash
# Honeycomb
export OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io
export OTEL_EXPORTER_OTLP_HEADERS=x-honeycomb-team=YOUR_API_KEY

# Datadog (via the Agent's OTLP receiver)
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

The full set of standard OpenTelemetry env vars (`OTEL_TRACES_EXPORTER`,
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_RESOURCE_ATTRIBUTES`, etc.)
is honored — Bitterbot uses the upstream `@opentelemetry/sdk-node`
auto-config and adds nothing on top.

## Spans Bitterbot emits

| Span name                 | Where                                | Attributes                                                   |
| ------------------------- | ------------------------------------ | ------------------------------------------------------------ |
| `gateway.rpc.<method>`    | Every gateway RPC frame              | `rpc.method`, `rpc.system`                                   |
| `agent.tool.<toolName>`   | Each tool execution (start → result) | `tool.name`, `tool.call_id`, `agent.run_id`, `tool.is_error` |
| `memory.search`           | `MemoryManager.search`               | `memory.query_len`, `memory.max_results`                     |
| `memory.dream`            | `MemoryManager.dream`                | `dream.engine`                                               |
| `long_horizon.run`        | A `LongHorizonRuntime.run()` call    | `long_horizon.thread_id`                                     |
| `long_horizon.work_step`  | One unit of agent work               | `phase=work`, `cycle`                                        |
| `long_horizon.dream_step` | One dream pass at the end of a cycle | `phase=dream`, `cycle`                                       |

Gateway RPC and tool spans are the ones most operators want first —
they directly answer "where is the latency coming from" and "which
tool errored". Memory and long-horizon spans are most useful for
multi-hour runs where you want to see the cycle pattern.

## What it looks like

A typical user-message → reply turn produces:

```
gateway.rpc.send                                    14.2s
├─ agent.tool.read                                   0.1s
├─ agent.tool.exec                                   8.4s
├─ memory.search                                     0.6s
└─ agent.tool.read                                   0.0s
```

A long-horizon run shows the biological cadence directly:

```
long_horizon.run                                     1h 47m
├─ long_horizon.work_step  ×27                      45m
├─ long_horizon.dream_step                           2m 14s
├─ long_horizon.work_step  ×31                      48m
├─ long_horizon.dream_step                           2m 33s
└─ long_horizon.work_step  ×9                        9m  (done=true)
```

## Configuration reference

| Env var                              | Purpose                                                 | Default               |
| ------------------------------------ | ------------------------------------------------------- | --------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`        | OTLP/HTTP collector base URL                            | unset = OTel disabled |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Override the traces endpoint specifically               | unset                 |
| `OTEL_TRACES_EXPORTER`               | Forces OTel init even without an endpoint set           | unset                 |
| `OTEL_SERVICE_NAME`                  | Span attribute `service.name`                           | `bitterbot-gateway`   |
| `OTEL_EXPORTER_OTLP_HEADERS`         | Auth headers for the collector (e.g. Honeycomb API key) | unset                 |
| `OTEL_RESOURCE_ATTRIBUTES`           | Extra resource attributes (`key=val,key=val`)           | unset                 |

OTel init runs once at gateway boot, before any spans are created. If
the SDK packages are missing — they are dynamically imported on enable
— the gateway logs a warning and continues with OTel disabled, so an
incomplete dependency install never breaks startup.

## Wiring custom spans

Subsystems that want to emit their own spans should import the helpers
from `src/observability/otel.ts`:

```typescript
import { withSpan, startSpan } from "../observability/otel.js";

// Single-function path:
const result = await withSpan("myFeature.expensiveOp", () => expensive(), {
  "feature.kind": "synthesis",
});

// Paired-event path (start/end events delivered separately):
const span = await startSpan("myFeature.async", { "feature.id": id });
// ...later, in a different handler:
span.end({ ok: true });
```

`withSpan` is a no-op when OTel is disabled (zero overhead). `startSpan`
returns a no-op handle in the same case. Both are safe to call from
anywhere in the codebase without checking enablement first.

## Caveats

- **Sampling.** No client-side sampling is configured. For high-volume
  deployments, set the standard `OTEL_TRACES_SAMPLER=parentbased_traceidratio`
  - `OTEL_TRACES_SAMPLER_ARG=0.1` env vars to keep ~10% of traces.
- **Dynamic imports.** OTel packages load lazily on first init. Cold
  start adds ~80 ms to gateway boot when enabled.
- **Propagation.** Trace context is **not** currently propagated across
  the orchestrator IPC boundary — orchestrator-side spans (when added)
  will start a new trace until that wiring lands.
