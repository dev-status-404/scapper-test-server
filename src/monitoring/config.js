import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { name: packageName, version: packageVersion } = require("../../package.json");

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

export const parseBoolean = (value, fallback = false) => {
  if (value == null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();

  if (TRUE_VALUES.has(normalized)) {
    return true;
  }

  if (FALSE_VALUES.has(normalized)) {
    return false;
  }

  return fallback;
};

export const parseNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const clampNumber = (value, min, max, fallback) =>
  Math.min(max, Math.max(min, parseNumber(value, fallback)));

export const appEnv =
  process.env.SENTRY_ENVIRONMENT ||
  process.env.DD_ENV ||
  process.env.NODE_ENV ||
  "development";

export const isTestEnv = appEnv === "test";
export const isProduction = appEnv === "production";

export const serviceName =
  process.env.OTEL_SERVICE_NAME ||
  process.env.DD_SERVICE ||
  process.env.APP_SERVICE_NAME ||
  packageName ||
  "scrapper-backend";

export const release =
  process.env.SENTRY_RELEASE ||
  process.env.DD_VERSION ||
  process.env.APP_VERSION ||
  packageVersion ||
  "1.0.0";
