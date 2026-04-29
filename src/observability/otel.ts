import { createSubsystemLogger } from "../logging/subsystem.js";

/**
 * OpenTelemetry SDK init. Enabled only when OTEL_TRACES_EXPORTER (or
 * OTEL_EXPORTER_OTLP_ENDPOINT) is set in the environment, matching the
 * standard OTel auto-config convention so any OTLP-compatible collector
 * (Grafana Tempo, Honeycomb, Datadog, Jaeger, etc.) works out of the box.
 *
 * When disabled, every helper here is a no-op and the runtime cost is
 * one env-var read per call to initOtel(). Dynamic imports keep the SDK
 * out of the cold-start path for users who don't opt in.
 *
 * Why:
 *   - PLAN-14 Pillar 6 (production observability) blocks Pillar 5.
 *   - Standard OTel env vars mean zero new config surface to maintain.
 *   - Dynamic imports mean adding @opentelemetry/* deps is a separate,
 *     reversible step. The build keeps working without them.
 */

const log = createSubsystemLogger("observability/otel");

type SdkHandle = {
  shutdown: () => Promise<void>;
};

type OtelState = {
  initialized: boolean;
  enabled: boolean;
  sdk?: SdkHandle;
};

const STATE_KEY = Symbol.for("bitterbot.observability.otel");

function resolveState(): OtelState {
  const proc = process as NodeJS.Process & { [STATE_KEY]?: OtelState };
  if (!proc[STATE_KEY]) {
    proc[STATE_KEY] = { initialized: false, enabled: false };
  }
  return proc[STATE_KEY];
}

export function isOtelEnabled(): boolean {
  return Boolean(
    process.env.OTEL_TRACES_EXPORTER ||
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
  );
}

/**
 * Initialize the OpenTelemetry SDK. Safe to call multiple times — only
 * the first call with OTel env vars present has effect. Returns true
 * if the SDK is now active, false if disabled or init failed.
 *
 * Add the OTel deps to your package.json before enabling:
 *   @opentelemetry/api
 *   @opentelemetry/sdk-node
 *   @opentelemetry/exporter-trace-otlp-http
 *   @opentelemetry/resources
 *   @opentelemetry/semantic-conventions
 */
export async function initOtel(opts?: { serviceName?: string }): Promise<boolean> {
  const state = resolveState();
  if (state.initialized) {
    return state.enabled;
  }
  state.initialized = true;

  if (!isOtelEnabled()) {
    return false;
  }

  const serviceName = opts?.serviceName ?? process.env.OTEL_SERVICE_NAME ?? "bitterbot-gateway";

  try {
    // Dynamic imports so missing deps don't break the build for users
    // who haven't opted in. The SDK only loads when env vars enable it.
    const [{ NodeSDK }, { OTLPTraceExporter }, { resourceFromAttributes }, semconv] =
      await Promise.all([
        import("@opentelemetry/sdk-node" as string),
        import("@opentelemetry/exporter-trace-otlp-http" as string),
        import("@opentelemetry/resources" as string),
        import("@opentelemetry/semantic-conventions" as string),
      ]);

    const exporter = new OTLPTraceExporter();
    const sdk = new NodeSDK({
      serviceName,
      traceExporter: exporter,
      resource: resourceFromAttributes({
        [semconv.ATTR_SERVICE_NAME]: serviceName,
        [semconv.ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? "unknown",
      }),
    });
    sdk.start();

    state.enabled = true;
    state.sdk = { shutdown: () => sdk.shutdown() };

    log.info(`OpenTelemetry initialized service=${serviceName}`);

    process.once("SIGTERM", () => void shutdownOtel());
    process.once("SIGINT", () => void shutdownOtel());

    return true;
  } catch (err) {
    log.warn(
      `OpenTelemetry init failed: ${err instanceof Error ? err.message : String(err)}. ` +
        `Install @opentelemetry/sdk-node + @opentelemetry/exporter-trace-otlp-http to enable.`,
    );
    return false;
  }
}

export async function shutdownOtel(): Promise<void> {
  const state = resolveState();
  if (state.sdk) {
    try {
      await state.sdk.shutdown();
    } catch (err) {
      log.warn(`OpenTelemetry shutdown error: ${err instanceof Error ? err.message : String(err)}`);
    }
    state.sdk = undefined;
    state.enabled = false;
  }
}

/**
 * Manually-paired span: start now, end later. Use this when the begin
 * and end events are delivered separately (e.g., tool execution start/end
 * events from the embedded runner). Returns a handle whose `end()` ends
 * the span — safe to call when OTel is disabled (no-op handle).
 */
type ManualSpan = {
  setAttribute: (k: string, v: string | number | boolean) => void;
  recordException: (e: unknown) => void;
  end: (status?: { ok: boolean; message?: string }) => void;
};

export async function startSpan(
  name: string,
  attrs?: Record<string, string | number | boolean>,
): Promise<ManualSpan> {
  const state = resolveState();
  if (!state.enabled) {
    return {
      setAttribute: () => {},
      recordException: () => {},
      end: () => {},
    };
  }
  try {
    const api = await import("@opentelemetry/api" as string);
    const tracer = api.trace.getTracer("bitterbot");
    const span = tracer.startSpan(name) as unknown as {
      setAttribute: (k: string, v: string | number | boolean) => void;
      recordException: (e: unknown) => void;
      setStatus: (s: { code: number; message?: string }) => void;
      end: () => void;
    };
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        span.setAttribute(k, v);
      }
    }
    return {
      setAttribute: (k, v) => span.setAttribute(k, v),
      recordException: (e) => span.recordException(e),
      end: (status) => {
        if (status && !status.ok) {
          span.setStatus({ code: 2, message: status.message });
        }
        span.end();
      },
    };
  } catch {
    return {
      setAttribute: () => {},
      recordException: () => {},
      end: () => {},
    };
  }
}

/**
 * Wrap a function in a span. No-op when OTel is disabled — the function
 * runs unchanged and span creation costs nothing. Use this for adding
 * incremental instrumentation to gateway turns, tool calls, memory ops,
 * and dream phases without touching the OTel API directly.
 */
export async function withSpan<T>(
  name: string,
  fn: () => Promise<T>,
  attrs?: Record<string, string | number | boolean>,
): Promise<T> {
  const state = resolveState();
  if (!state.enabled) {
    return fn();
  }
  try {
    const api = await import("@opentelemetry/api" as string);
    const tracer = api.trace.getTracer("bitterbot");
    return await tracer.startActiveSpan(name, async (span: unknown) => {
      const s = span as {
        setAttribute: (k: string, v: string | number | boolean) => void;
        recordException: (e: unknown) => void;
        setStatus: (s: { code: number; message?: string }) => void;
        end: () => void;
      };
      try {
        if (attrs) {
          for (const [k, v] of Object.entries(attrs)) {
            s.setAttribute(k, v);
          }
        }
        return await fn();
      } catch (err) {
        s.recordException(err);
        s.setStatus({ code: 2, message: err instanceof Error ? err.message : String(err) });
        throw err;
      } finally {
        s.end();
      }
    });
  } catch {
    return fn();
  }
}
