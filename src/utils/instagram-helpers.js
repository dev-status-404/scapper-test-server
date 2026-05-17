// ═══════════════════════════════════════════════════════════════════════════
// Instagram Scraping Helper Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Split full name into first and last name
 * @param {string} fullName - Full name to split
 * @returns {Object} {first_name, last_name}
 */
export const splitName = (fullName) => {
  if (!fullName || typeof fullName !== "string") {
    return { first_name: null, last_name: null };
  }
  const parts = fullName.trim().split(" ");
  return {
    first_name: parts[0] || null,
    last_name: parts.slice(1).join(" ") || null,
  };
};

/**
 * Get unique values from array, filtering out falsy values
 * @param {Array} values - Array values to deduplicate
 * @returns {Array} Unique values
 */
export const uniqueValues = (values) => [...new Set(values.filter(Boolean))];

/**
 * Parse follower/following count (handles K/M suffixes)
 * @param {string|number} value - Count value to parse
 * @returns {number|null} Parsed numeric count
 */
export const parseCount = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  const text = String(value).trim().toLowerCase();
  if (!text) return null;

  const normalized = text.replace(/,/g, "");
  const match = normalized.match(/^(\d+(?:\.\d+)?)([km])?$/i);

  if (!match) {
    const digitsOnly = normalized.replace(/[^\d]/g, "");
    return digitsOnly ? Number(digitsOnly) : null;
  }

  const base = Number(match[1]);
  const suffix = match[2]?.toLowerCase();

  if (suffix === "k") return Math.round(base * 1000);
  if (suffix === "m") return Math.round(base * 1000000);
  return Math.round(base);
};

/**
 * Normalize URL (validate and return canonical form)
 * @param {string} url - URL to normalize
 * @returns {string|null} Normalized URL or null if invalid
 */
export const normalizeUrl = (url) => {
  if (!url || typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    return parsed.toString();
  } catch {
    return null;
  }
};

/**
 * Human-like delay (random timing)
 * @param {number} min - Minimum delay in ms
 * @param {number} max - Maximum delay in ms
 * @returns {Promise} Promise that resolves after delay
 */
export const humanDelay = (min = 1000, max = 3000) => {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, delay));
};

/**
 * Longer delay for page loads
 * @returns {Promise} Promise that resolves after delay
 */
export const pageLoadDelay = () => humanDelay(2000, 4000);

/**
 * Gentle scroll delay
 * @returns {Promise} Promise that resolves after delay
 */
export const scrollDelay = () => humanDelay(800, 1500);

/**
 * Type like a human (character by character with random delays)
 * @param {Page} page - Puppeteer page object
 * @param {string} selector - CSS selector for input field
 * @param {string} text - Text to type
 * @param {number} delayBetweenKeys - Base delay between keystrokes
 * @returns {Promise} Promise that resolves when typing is complete
 */
export const humanType = async (
  page,
  selector,
  text,
  delayBetweenKeys = 100,
) => {
  await page.waitForSelector(selector, { visible: true, timeout: 10000 });
  await page.click(selector);
  await humanDelay(300, 600);

  for (const char of text) {
    await page.type(selector, char);
    await new Promise((resolve) =>
      setTimeout(resolve, delayBetweenKeys + Math.random() * 50),
    );
  }
};

/**
 * Check if URL domain should be skipped during deep scan
 * @param {string} url - URL to check
 * @param {Array} skipDomains - Array of domains to skip
 * @returns {boolean} True if domain should be skipped
 */
export const shouldSkipDomain = (url, skipDomains) => {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase().replace(/^www\\./, "");

    // Check if hostname matches or ends with any skip domain
    return skipDomains.some((domain) => {
      return hostname === domain || hostname.endsWith("." + domain);
    });
  } catch (error) {
    return false;
  }
};
