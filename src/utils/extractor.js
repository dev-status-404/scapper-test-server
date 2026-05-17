const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

// Match phone numbers in specific formats:
// +123456789012 (international with +)
// (123)-456-7890 or (123) 456-7890 (with parentheses and dashes/spaces)
// 123-456-7890 or 123 456 7890 (with dashes or spaces)
const PHONE_REGEX =
  /(?:\+\d{1,4}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/g;

const uniqueValues = (values) => [...new Set(values.filter(Boolean))];

const normalizeEmail = (value) => {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().toLowerCase();
};

const normalizePhone = (value) => {
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
    /^\+\d[\d\s.-]{7,}$/, // International: starts with +digit
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

const extractEmails = (text) => {
  if (typeof text !== "string" || !text.trim()) {
    return [];
  }

  const matches = text.match(EMAIL_REGEX) || [];
  return uniqueValues(matches.map(normalizeEmail));
};

const extractPhones = (text) => {
  if (typeof text !== "string" || !text.trim()) {
    return [];
  }

  const matches = text.match(PHONE_REGEX) || [];
  return uniqueValues(matches.map(normalizePhone));
};

export { extractEmails, extractPhones };
