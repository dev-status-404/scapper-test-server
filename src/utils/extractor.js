const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const URL_WITH_SCHEME_REGEX = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
const DOMAIN_URL_REGEX =
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63})(?:\/[^\s<>"'`]*)?/gi;

// Match phone numbers in specific formats:
// +123456789012 (international with +)
// (123)-456-7890 or (123) 456-7890 (with parentheses and dashes/spaces)
// 123-456-7890 or 123 456 7890 (with dashes or spaces)
const PHONE_REGEX =
  /(?:\+\d{1,4}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/g;

const uniqueValues = (values) => [...new Set(values.filter(Boolean))];
const COMMON_TLDS = [
  "com",
  "net",
  "org",
  "io",
  "co",
  "ai",
  "app",
  "dev",
  "biz",
  "info",
  "me",
  "edu",
  "gov",
  "us",
  "uk",
  "ca",
  "au",
  "de",
  "fr",
  "es",
  "pk",
];

const normalizeEmailCandidate = (value) => {
  if (typeof value !== "string") {
    return "";
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return "";
  }

  const compact = normalized.replace(/[>,;:'"`]+$/g, "");
  const withKnownTldBoundary = compact.match(
    new RegExp(
      `^([a-z0-9._%+-]+@[a-z0-9.-]+\\.(?:${COMMON_TLDS.join("|")}))(?:[a-z]{2,})?$`,
      "i",
    ),
  );

  if (withKnownTldBoundary) {
    return withKnownTldBoundary[1].toLowerCase();
  }

  return compact;
};

const normalizePhoneCandidate = (value) => {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  // Check if it starts with + (international format)
  const hasPlus = trimmed.startsWith("+");

  // Check for valid formats:
  // +1234567890 (starts with +digit)
  // (000)-0000-0000 or (000) 000-0000
  // 000-000-0000 or 000 000 0000
  const validPatterns = [
    /^\+\d[\d()\s.-]{7,}$/, // International: allows separators and area-code parentheses
    /^\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}$/, // US/Standard format
  ];

  const isValidFormat = validPatterns.some((pattern) => pattern.test(trimmed));
  if (!isValidFormat) {
    return "";
  }

  const digitsOnly = trimmed.replace(/\D/g, "");

  // Must have at least 10 digits for valid phone number
  if (digitsOnly.length < 10 || digitsOnly.length > 15) {
    return "";
  }

  // Avoid numbers with too many repeating digits (like 0000000000)
  const repeatingPattern = /(\d)\1{7,}/;
  if (repeatingPattern.test(digitsOnly)) {
    return "";
  }

  return hasPlus ? `+${digitsOnly}` : digitsOnly;
};

const trimUrlPunctuation = (value) =>
  String(value || "")
    .trim()
    .replace(/^[([{'"`]+/, "")
    .replace(/[)\]},;:!?'"`]+$/g, "");

const normalizeUrl = (value) => {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = trimUrlPunctuation(value);
  if (!trimmed || trimmed.includes("@")) {
    return "";
  }

  try {
    const withScheme = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    const parsed = new URL(withScheme);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "";
    }

    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    if (parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    } else {
      parsed.pathname = "/";
    }

    return parsed.toString();
  } catch {
    return "";
  }
};

const collectRegexMatches = (
  text,
  pattern,
  { skipWhenImmediatelyProtocolPrefixed = false } = {},
) => {
  const matches = [];
  const regex = new RegExp(pattern.source, pattern.flags);

  for (const match of text.matchAll(regex)) {
    const raw = match?.[0];
    const index = Number.isInteger(match?.index) ? match.index : -1;
    if (!raw) {
      continue;
    }

    // Avoid turning email domains like `name@example.com` into website candidates.
    if (index > 0 && text[index - 1] === "@") {
      continue;
    }

    if (
      skipWhenImmediatelyProtocolPrefixed &&
      text.slice(Math.max(0, index - 3), index) === "://"
    ) {
      continue;
    }

    matches.push(raw);
  }

  return matches;
};

const extractEmails = (text) => {
  if (typeof text !== "string" || !text.trim()) {
    return [];
  }

  const matches = text.match(EMAIL_REGEX) || [];
  return uniqueValues(matches.map(normalizeEmailCandidate));
};

const extractPhones = (text) => {
  if (typeof text !== "string" || !text.trim()) {
    return [];
  }

  const matches = text.match(PHONE_REGEX) || [];
  return uniqueValues(matches.map(normalizePhoneCandidate));
};

const extractUrls = (text) => {
  if (typeof text !== "string" || !text.trim()) {
    return [];
  }

  const matches = [
    ...collectRegexMatches(text, URL_WITH_SCHEME_REGEX),
    ...collectRegexMatches(text, DOMAIN_URL_REGEX, {
      skipWhenImmediatelyProtocolPrefixed: true,
    }),
  ];

  return uniqueValues(matches.map(normalizeUrl));
};

export {
  extractEmails,
  extractPhones,
  extractUrls,
  normalizeEmailCandidate,
  normalizePhoneCandidate,
};
