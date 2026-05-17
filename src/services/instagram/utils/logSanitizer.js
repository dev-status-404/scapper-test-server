const SECRET_KEY_PATTERN =
  /(token|secret|password|authorization|cookie|session|csrftoken|apikey|api_key|key)$/i;

const redactString = (value) => {
  const text = String(value);
  if (!text) return text;

  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/(apify_api_)[A-Za-z0-9._~-]+/gi, "$1[REDACTED]")
    .replace(/(sessionid=)[^;\s]+/gi, "$1[REDACTED]")
    .replace(/(csrftoken=)[^;\s]+/gi, "$1[REDACTED]")
    .replace(/(password=)[^&\s]+/gi, "$1[REDACTED]");
};

export const sanitizeForLog = (value, depth = 0) => {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object") return value;
  if (depth > 4) return "[Truncated]";

  if (Array.isArray(value)) {
    if (value.length > 25) {
      return {
        type: "array",
        length: value.length,
        preview: value.slice(0, 5).map((entry) => sanitizeForLog(entry, depth + 1)),
      };
    }
    return value.map((entry) => sanitizeForLog(entry, depth + 1));
  }

  const sanitized = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      sanitized[key] = "[REDACTED]";
      continue;
    }
    sanitized[key] = sanitizeForLog(entry, depth + 1);
  }
  return sanitized;
};

export default sanitizeForLog;

