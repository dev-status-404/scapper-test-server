import * as Sentry from "@sentry/node";
import {
  appEnv,
  clampNumber,
  isProduction,
  isTestEnv,
  parseBoolean,
  release,
  serviceName,
} from "./config.js";

const sentryEnabled =
  !isTestEnv &&
  Boolean(process.env.SENTRY_DSN) &&
  parseBoolean(process.env.SENTRY_ENABLED, true);

const SENSITIVE_KEY_PATTERN =
  /(authorization|cookie|password|secret|token|api[-_]?key|smtp|authTag|encrypted|iv)/i;

const redactSensitiveData = (value, key = "", seen = new WeakSet()) => {
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return "[REDACTED]";
  }

  if (value == null || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveData(item, key, seen));
  }

  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactSensitiveData(entryValue, entryKey, seen),
    ]),
  );
};

if (sentryEnabled) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    enabled: true,
    environment: appEnv,
    release,
    serverName: serviceName,
    tracesSampleRate: clampNumber(
      process.env.SENTRY_TRACES_SAMPLE_RATE,
      0,
      1,
      isProduction ? 0.15 : 1,
    ),
    sendDefaultPii: parseBoolean(process.env.SENTRY_SEND_DEFAULT_PII, false),
    integrations: [
      Sentry.extraErrorDataIntegration(),
    ],
    initialScope: {
      tags: {
        service: serviceName,
        runtime: "node",
        environment: appEnv,
      },
    },
    beforeSend(event) {
      return redactSensitiveData(event);
    },
  });
}

export { Sentry };
export const isSentryEnabled = () => sentryEnabled;
