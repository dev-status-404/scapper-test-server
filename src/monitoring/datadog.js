import ddTrace from "dd-trace";
import {
  appEnv,
  clampNumber,
  isProduction,
  isTestEnv,
  parseBoolean,
  serviceName,
  release,
} from "./config.js";

const datadogEnabled =
  !isTestEnv &&
  parseBoolean(
    process.env.DD_TRACE_ENABLED ?? process.env.DATADOG_ENABLED,
    Boolean(process.env.DD_TRACE_AGENT_URL || process.env.DD_AGENT_HOST),
  );

const tracer = datadogEnabled
  ? ddTrace.init({
      service: serviceName,
      env: appEnv,
      version: release,
      logInjection: parseBoolean(process.env.DD_LOGS_INJECTION, true),
      runtimeMetrics: parseBoolean(
        process.env.DD_RUNTIME_METRICS_ENABLED,
        isProduction,
      )
        ? {
            enabled: true,
            gc: true,
            eventLoop: true,
          }
        : false,
      profiling: parseBoolean(process.env.DD_PROFILING_ENABLED, false),
      startupLogs: parseBoolean(process.env.DD_TRACE_STARTUP_LOGS, isProduction),
      sampleRate: clampNumber(
        process.env.DD_TRACE_SAMPLE_RATE,
        0,
        1,
        isProduction ? 0.2 : 1,
      ),
    })
  : ddTrace;

const normalizeAttributeValue = (value) => {
  if (value == null) {
    return undefined;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return JSON.stringify(value);
};

export const isDatadogEnabled = () => datadogEnabled;

export const getActiveDatadogSpan = () =>
  datadogEnabled && typeof tracer.scope === "function"
    ? tracer.scope().active()
    : null;

export const annotateActiveDatadogSpan = (attributes = {}) => {
  const span = getActiveDatadogSpan();

  if (!span || typeof span.setAttribute !== "function") {
    return;
  }

  Object.entries(attributes).forEach(([key, value]) => {
    const normalizedValue = normalizeAttributeValue(value);
    if (normalizedValue !== undefined) {
      span.setAttribute(key, normalizedValue);
    }
  });
};

const markDatadogSpanAsError = (span, error) => {
  if (!span) {
    return;
  }

  if (typeof span.recordException === "function") {
    span.recordException(error);
  }

  if (typeof span.setAttribute === "function") {
    span.setAttribute("error", true);
    span.setAttribute("error.type", error?.name || "Error");
    span.setAttribute("error.message", error?.message || "unknown-error");
  }
};

export const withDatadogSpan = async (name, attributes = {}, callback) => {
  if (!datadogEnabled || typeof tracer.startActiveSpan !== "function") {
    return callback(null);
  }

  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await callback(span);
    } catch (error) {
      markDatadogSpanAsError(span, error);
      throw error;
    } finally {
      if (typeof span.end === "function") {
        span.end();
      }
    }
  });
};

export const flushDatadog = () => {
  try {
    tracer.flush?.();
  } catch {
    // best effort flush only
  }
};

export default tracer;
