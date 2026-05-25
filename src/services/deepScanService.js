import axios from "axios";
import { DelayedError, Queue, QueueEvents, Worker } from "bullmq";
import * as cheerio from "cheerio";
import crypto from "crypto";
import dns from "dns/promises";
import net from "net";
import { HttpsProxyAgent } from "https-proxy-agent";
import { getRedisConnectionOptions, getSharedRedisClient } from "../config/redis.js";
import DeepScanResult from "../models/deepScanResult.model.js";
import Lead from "../models/lead.model.js";
import {
  bindErrorContext,
  captureException,
  withMonitoringSpan,
} from "../monitoring/index.js";
import { getIO } from "../websockets/index.js";
import {
  extractEmails,
  extractPhones,
  normalizeEmailCandidate,
} from "../utils/extractor.js";
import { getNextProxyConfig, proxyConfigToUrl } from "../config/instagram-proxy.js";
import { sanitizeForLog } from "./instagram/utils/logSanitizer.js";

const clampNumber = (value, min, max, fallback) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

export const DEEP_SCAN_ENABLED = process.env.DEEP_SCAN_ENABLED === "true";
export const DEEP_SCAN_RELATIONSHIP_ENABLED =
  process.env.DEEP_SCAN_RELATIONSHIP_ENABLED === "true";
export const DEEP_SCAN_INLINE_SINGLE_PROFILE =
  process.env.DEEP_SCAN_INLINE_SINGLE_PROFILE === "true";
export const DEEP_SCAN_DIRECT_FALLBACK_ENABLED =
  process.env.DEEP_SCAN_DIRECT_FALLBACK_ENABLED !== "false";

export const DEEP_SCAN_TIMEOUT_MS = clampNumber(
  process.env.DEEP_SCAN_TIMEOUT_MS,
  3000,
  60000,
  15000,
);
export const DEEP_SCAN_RETRY_DELAY_MS = clampNumber(
  process.env.DEEP_SCAN_RETRY_DELAY_MS,
  1000,
  60000,
  5000,
);
export const DEEP_SCAN_MAX_ATTEMPTS = clampNumber(
  process.env.DEEP_SCAN_MAX_ATTEMPTS,
  1,
  5,
  3,
);
export const DEEP_SCAN_MAX_REDIRECTS = clampNumber(
  process.env.DEEP_SCAN_MAX_REDIRECTS,
  0,
  5,
  3,
);
export const DEEP_SCAN_MAX_CONTENT_BYTES = clampNumber(
  process.env.DEEP_SCAN_MAX_CONTENT_BYTES,
  128 * 1024,
  2 * 1024 * 1024,
  512 * 1024,
);
export const DEEP_SCAN_MAX_PAGES_PER_DOMAIN = clampNumber(
  process.env.DEEP_SCAN_MAX_PAGES_PER_DOMAIN,
  1,
  10,
  3,
);
export const DEEP_SCAN_CACHE_TTL_DAYS = clampNumber(
  process.env.DEEP_SCAN_CACHE_TTL_DAYS,
  1,
  365,
  30,
);
export const DEEP_SCAN_CONCURRENCY_GLOBAL = clampNumber(
  process.env.DEEP_SCAN_CONCURRENCY_GLOBAL,
  1,
  100,
  10,
);
export const DEEP_SCAN_CONCURRENCY_PER_USER = clampNumber(
  process.env.DEEP_SCAN_CONCURRENCY_PER_USER,
  1,
  20,
  2,
);
export const DEEP_SCAN_CONCURRENCY_PER_DOMAIN = clampNumber(
  process.env.DEEP_SCAN_CONCURRENCY_PER_DOMAIN,
  1,
  5,
  1,
);
export const DEEP_SCAN_ISOLATION_TTL_MS = clampNumber(
  process.env.DEEP_SCAN_ISOLATION_TTL_MS,
  5000,
  10 * 60 * 1000,
  Math.max(60_000, DEEP_SCAN_TIMEOUT_MS * 4),
);

export const SKIP_DOMAINS = [
  "instagram.com",
  "facebook.com",
  "x.com",
  "twitter.com",
  "linkedin.com",
  "youtube.com",
  "tiktok.com",
  "snapchat.com",
  "pinterest.com",
  "reddit.com",
  "telegram.org",
  "whatsapp.com",
  "discord.com",
  "google.com",
  "apple.com",
  "microsoft.com",
  "amazon.com",
  "spotify.com",
  "netflix.com",
  "bit.ly",
  "t.co",
  "tinyurl.com",
  "linktr.ee",
  "beacons.ai",
  "stan.store",
];

const activeDomainLocks = new Map();
const activeUserLocks = new Map();
const DEEP_SCAN_QUEUE_NAME = "deep-scan";
const DEEP_SCAN_QUEUE_PREFIX = process.env.DEEP_SCAN_QUEUE_PREFIX || "bull";
let deepScanQueue = null;
let deepScanWorker = null;
let deepScanQueueEvents = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const incrementLock = (locks, key) => {
  locks.set(key, (locks.get(key) || 0) + 1);
};

const decrementLock = (locks, key) => {
  const remaining = (locks.get(key) || 1) - 1;
  if (remaining <= 0) locks.delete(key);
  else locks.set(key, remaining);
};

const DEEP_SCAN_ISOLATION_ACQUIRE_SCRIPT = `
local userKey = KEYS[1]
local domainKey = KEYS[2]
local userLimit = tonumber(ARGV[1])
local domainLimit = tonumber(ARGV[2])
local ttlMs = tonumber(ARGV[3])

local userCount = tonumber(redis.call("get", userKey) or "0")
if userCount >= userLimit then
  return {0, "user-concurrency-limit"}
end

local domainCount = tonumber(redis.call("get", domainKey) or "0")
if domainCount >= domainLimit then
  return {0, "domain-concurrency-limit"}
end

redis.call("incr", userKey)
redis.call("pexpire", userKey, ttlMs)
redis.call("incr", domainKey)
redis.call("pexpire", domainKey, ttlMs)

return {1, "acquired"}
`;

const DEEP_SCAN_ISOLATION_RELEASE_SCRIPT = `
local userKey = KEYS[1]
local domainKey = KEYS[2]

local userCount = tonumber(redis.call("get", userKey) or "0")
if userCount > 1 then
  redis.call("decr", userKey)
elseif userCount == 1 then
  redis.call("del", userKey)
end

local domainCount = tonumber(redis.call("get", domainKey) or "0")
if domainCount > 1 then
  redis.call("decr", domainKey)
elseif domainCount == 1 then
  redis.call("del", domainKey)
end

return 1
`;

const buildIsolationRedisKey = (scope, key) => `deep-scan:isolation:${scope}:${key}`;

const shouldUseRedisIsolation = () => process.env.NODE_ENV !== "test";

const startIsolationHeartbeat = (redis, keys) => {
  const intervalMs = Math.max(1000, Math.floor(DEEP_SCAN_ISOLATION_TTL_MS / 3));
  const timer = setInterval(() => {
    redis
      .multi()
      .pexpire(keys.userKey, DEEP_SCAN_ISOLATION_TTL_MS)
      .pexpire(keys.domainKey, DEEP_SCAN_ISOLATION_TTL_MS)
      .exec()
      .catch((error) => {
        console.warn(
          `[DeepScan] Isolation heartbeat failed: ${error?.message || "unknown-error"}`,
        );
      });
  }, intervalMs);

  if (typeof timer.unref === "function") {
    timer.unref();
  }

  return () => clearInterval(timer);
};

const acquireInMemoryIsolation = ({ user_id, url }) => {
  const keys = getDeepScanIsolationKeys({ user_id, url });

  if (!keys.normalized_url || !keys.root_domain) {
    return { acquired: true, ...keys, release: async () => {} };
  }

  if ((activeUserLocks.get(keys.user_key) || 0) >= DEEP_SCAN_CONCURRENCY_PER_USER) {
    return { acquired: false, reason: "user-concurrency-limit", ...keys };
  }

  if ((activeDomainLocks.get(keys.root_domain) || 0) >= DEEP_SCAN_CONCURRENCY_PER_DOMAIN) {
    return { acquired: false, reason: "domain-concurrency-limit", ...keys };
  }

  incrementLock(activeUserLocks, keys.user_key);
  incrementLock(activeDomainLocks, keys.root_domain);
  let released = false;

  return {
    acquired: true,
    ...keys,
    release: async () => {
      if (released) return;
      released = true;
      decrementLock(activeUserLocks, keys.user_key);
      decrementLock(activeDomainLocks, keys.root_domain);
    },
  };
};

export const getDeepScanIsolationKeys = ({ user_id, url }) => {
  const normalizedUrl = normalizeDeepScanUrl(url);
  return {
    normalized_url: normalizedUrl,
    user_key: user_id ? String(user_id) : "anonymous",
    root_domain: normalizedUrl ? getRootDomain(new URL(normalizedUrl).hostname) : null,
  };
};

export const tryAcquireDeepScanIsolation = async ({ user_id, url }) => {
  const keys = getDeepScanIsolationKeys({ user_id, url });

  if (!keys.normalized_url || !keys.root_domain) {
    return { acquired: true, ...keys, release: async () => {} };
  }

  if (!shouldUseRedisIsolation()) {
    return acquireInMemoryIsolation({ user_id, url });
  }

  const redis = getSharedRedisClient();
  const redisKeys = {
    userKey: buildIsolationRedisKey("user", keys.user_key),
    domainKey: buildIsolationRedisKey("domain", keys.root_domain),
  };

  try {
    const [acquiredRaw, reason] = await redis.eval(
      DEEP_SCAN_ISOLATION_ACQUIRE_SCRIPT,
      2,
      redisKeys.userKey,
      redisKeys.domainKey,
      String(DEEP_SCAN_CONCURRENCY_PER_USER),
      String(DEEP_SCAN_CONCURRENCY_PER_DOMAIN),
      String(DEEP_SCAN_ISOLATION_TTL_MS),
    );

    if (Number(acquiredRaw) !== 1) {
      return { acquired: false, reason: String(reason || "isolation-unavailable"), ...keys };
    }

    const stopHeartbeat = startIsolationHeartbeat(redis, redisKeys);
    let released = false;

    return {
      acquired: true,
      ...keys,
      release: async () => {
        if (released) return;
        released = true;
        stopHeartbeat();
        await redis.eval(
          DEEP_SCAN_ISOLATION_RELEASE_SCRIPT,
          2,
          redisKeys.userKey,
          redisKeys.domainKey,
        );
      },
    };
  } catch (error) {
    logDeepScan("deep_scan_isolation_error", {
      normalized_url: keys.normalized_url,
      root_domain: keys.root_domain,
      error_message: error?.message || "redis-isolation-error",
    });
    throw error;
  }
};

const logDeepScan = (event, payload = {}) => {
  console.log(JSON.stringify(sanitizeForLog({ event, ...payload })));
};

export const getRootDomain = (urlOrHostname) => {
  const hostname = String(urlOrHostname || "")
    .replace(/^https?:\/\//i, "")
    .split("/")[0]
    .split(":")[0]
    .toLowerCase()
    .replace(/^www\./, "");
  const parts = hostname.split(".").filter(Boolean);
  if (parts.length <= 2) return hostname;
  return parts.slice(-2).join(".");
};

export const normalizeDeepScanUrl = (input) => {
  const trimmed = String(input || "").trim();
  if (!trimmed) return null;

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (!["http:", "https:"].includes(parsed.protocol)) return null;
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  if (parsed.pathname.length > 1) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  } else {
    parsed.pathname = "/";
  }

  return parsed.toString();
};

export const shouldSkipDeepScanDomain = (url) => {
  const normalized = normalizeDeepScanUrl(url);
  if (!normalized) return false;
  const hostname = new URL(normalized).hostname.toLowerCase().replace(/^www\./, "");
  return SKIP_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
};

export const isPrivateOrInternalIp = (ip) => {
  if (!ip) return true;
  if (ip === "169.254.169.254") return true;
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map((part) => Number.parseInt(part, 10));
    const [a, b] = parts;
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a === 0
    );
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return (
      lower === "::1" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe80") ||
      lower === "::" ||
      lower.includes("169.254.169.254")
    );
  }
  return true;
};

export const validateUrlSafeToFetch = async (url) => {
  const normalized = normalizeDeepScanUrl(url);
  if (!normalized) {
    return { safe: false, normalized_url: null, status: "BLOCKED", reason: "invalid-url" };
  }

  const parsed = new URL(normalized);
  if (parsed.hostname === "localhost" || parsed.hostname.endsWith(".localhost")) {
    return { safe: false, normalized_url: normalized, status: "BLOCKED", reason: "localhost" };
  }

  const literalIp = net.isIP(parsed.hostname) ? parsed.hostname : null;
  const addresses = literalIp
    ? [{ address: literalIp }]
    : await dns.lookup(parsed.hostname, { all: true }).catch(() => []);

  if (!addresses.length) {
    return { safe: false, normalized_url: normalized, status: "BLOCKED", reason: "dns-empty" };
  }

  if (addresses.some((entry) => isPrivateOrInternalIp(entry.address))) {
    return { safe: false, normalized_url: normalized, status: "BLOCKED", reason: "private-ip" };
  }

  return { safe: true, normalized_url: normalized, root_domain: getRootDomain(parsed.hostname) };
};

const getErrorStatus = (error) =>
  error?.response?.status ?? error?.response?.statusCode ?? error?.statusCode ?? error?.status;

export const shouldRetryDeepScanWithoutProxy = (error, { proxyUsed = true } = {}) => {
  if (!proxyUsed || !DEEP_SCAN_DIRECT_FALLBACK_ENABLED) {
    return false;
  }

  const status = getErrorStatus(error);
  return [401, 403, 407].includes(status);
};

export const isDeepScanRetryableError = (error) => {
  const status = getErrorStatus(error);
  const message = String(error?.message || "").toLowerCase();
  const responseText = String(error?.response?.data || "").toLowerCase();

  return (
    [408, 425, 429, 500, 502, 503, 504].includes(status) ||
    ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"].includes(error?.code) ||
    message.includes("socket hang up") ||
    message.includes("timeout") ||
    message.includes("bad gateway") ||
    responseText.includes("session has ended") ||
    responseText.includes("suitable exit node")
  );
};

const normalizePhones = (phones = []) =>
  [...new Set(phones.map((phone) => String(phone || "").trim()).filter(Boolean))]
    .filter((phone) => phone.replace(/\D/g, "").length >= 7);

const normalizeEmails = (emails = []) =>
  [...new Set(emails.map((email) => normalizeEmailCandidate(email)).filter(Boolean))]
    .filter((email) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email));

const extractJsonLdContacts = ($) => {
  const emails = [];
  const phones = [];
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      const parsed = JSON.parse($(element).text());
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of nodes) {
        if (node?.email) emails.push(node.email);
        if (node?.telephone) phones.push(node.telephone);
        if (node?.contactPoint) {
          const points = Array.isArray(node.contactPoint) ? node.contactPoint : [node.contactPoint];
          for (const point of points) {
            if (point?.email) emails.push(point.email);
            if (point?.telephone) phones.push(point.telephone);
          }
        }
      }
    } catch {
      // ignore malformed JSON-LD
    }
  });
  return { emails, phones };
};

export const discoverContactPageUrls = (html, baseUrl) => {
  const $ = cheerio.load(html || "");
  const base = new URL(baseUrl);
  const urls = [];
  $("a[href]").each((_, element) => {
    const href = $(element).attr("href") || "";
    const text = $(element).text() || "";
    const haystack = `${href} ${text}`.toLowerCase();
    if (!/(contact|contact-us|about|support)/.test(haystack)) return;
    try {
      const candidate = new URL(href, base);
      if (candidate.hostname !== base.hostname) return;
      const normalized = normalizeDeepScanUrl(candidate.toString());
      if (normalized && !urls.includes(normalized)) urls.push(normalized);
    } catch {
      // ignore bad hrefs
    }
  });
  $.root().empty();
  return urls.slice(0, Math.max(0, DEEP_SCAN_MAX_PAGES_PER_DOMAIN - 1));
};

export const extractDeepScanContactsFromHtml = (html, url) => {
  const $ = cheerio.load(html || "");
  const visibleText = $("body").text();
  const mailtoEmails = $('a[href^="mailto:"]')
    .map((_, element) => ($(element).attr("href") || "").replace(/^mailto:/i, "").split("?")[0])
    .get();
  const telPhones = $('a[href^="tel:"]')
    .map((_, element) => ($(element).attr("href") || "").replace(/^tel:/i, ""))
    .get();
  const jsonLd = extractJsonLdContacts($);
  const result = {
    emails: normalizeEmails([...extractEmails(visibleText), ...mailtoEmails, ...jsonLd.emails]),
    phone_numbers: normalizePhones([...extractPhones(visibleText), ...telPhones, ...jsonLd.phones]),
    html_title: $("title").first().text().trim() || null,
    contact_page_urls: discoverContactPageUrls(html, url),
  };
  $.root().empty();
  return result;
};

const makeResultPayload = ({
  normalizedUrl,
  finalUrl = normalizedUrl,
  rootDomain,
  status,
  httpStatus = null,
  emails = [],
  phoneNumbers = [],
  contactPageUrls = [],
  htmlTitle = null,
  scannedPagesCount = 0,
  errorType = null,
  errorMessage = null,
  attempts = 0,
}) => ({
  normalized_url: normalizedUrl,
  source_url: normalizedUrl,
  final_url: finalUrl,
  root_domain: rootDomain || (normalizedUrl ? getRootDomain(new URL(normalizedUrl).hostname) : null),
  status,
  http_status: httpStatus,
  emails: normalizeEmails(emails),
  phone_numbers: normalizePhones(phoneNumbers),
  contact_page_urls: contactPageUrls,
  html_title: htmlTitle,
  scanned_pages_count: scannedPagesCount,
  error_type: errorType,
  error_message: errorMessage,
  scan_attempts: attempts,
  skipped: status === "SKIPPED",
});

const toLegacyResult = (result, extra = {}) => ({
  ...result,
  source_url: result.normalized_url,
  skipped: result.status === "SKIPPED",
  cached: false,
  ...extra,
});

const buildExpiresAt = () =>
  new Date(Date.now() + DEEP_SCAN_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);

const persistResult = async ({
  result,
  leadIds = [],
  sourceUsernames = [],
  resultModel = DeepScanResult,
}) =>
  resultModel.findOneAndUpdate(
    { normalized_url: result.normalized_url },
    {
      $set: {
        root_domain: result.root_domain,
        final_url: result.final_url,
        status: result.status,
        http_status: result.http_status,
        emails: result.emails,
        phone_numbers: result.phone_numbers,
        contact_page_urls: result.contact_page_urls,
        html_title: result.html_title,
        error_type: result.error_type,
        error_message: result.error_message,
        scan_attempts: result.scan_attempts,
        last_scanned_at: new Date(),
        expires_at: buildExpiresAt(),
        metadata: {
          scanned_pages_count: result.scanned_pages_count,
        },
      },
      $addToSet: {
        source_lead_ids: { $each: leadIds.filter(Boolean) },
        source_usernames: { $each: sourceUsernames.filter(Boolean) },
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

export const getCachedDeepScanResult = async (
  normalizedUrl,
  resultModel = DeepScanResult,
) => {
  const cached = await resultModel.findOne({
    normalized_url: normalizedUrl,
    expires_at: { $gt: new Date() },
  }).lean();
  return cached || null;
};

export const previewDeepScanRequest = async (
  url,
  { resultModel = DeepScanResult } = {},
) => {
  const normalizedUrl = normalizeDeepScanUrl(url);

  if (!normalizedUrl) {
    return {
      ok: false,
      statusCode: 400,
      reason: "invalid-url",
      normalized_url: null,
      billable: false,
      cached_result: null,
    };
  }

  const cached = await getCachedDeepScanResult(normalizedUrl, resultModel);
  if (cached) {
    return {
      ok: true,
      statusCode: 200,
      reason: "cache-hit",
      normalized_url: normalizedUrl,
      billable: false,
      cached_result: toLegacyResult(cached, { cached: true }),
    };
  }

  if (shouldSkipDeepScanDomain(normalizedUrl)) {
    return {
      ok: true,
      statusCode: 200,
      reason: "skipped-domain",
      normalized_url: normalizedUrl,
      billable: false,
      cached_result: null,
    };
  }

  const safety = await validateUrlSafeToFetch(normalizedUrl);
  if (!safety.safe) {
    return {
      ok: true,
      statusCode: 200,
      reason: safety.reason,
      normalized_url: normalizedUrl,
      billable: false,
      cached_result: null,
    };
  }

  return {
    ok: true,
    statusCode: 200,
    reason: "fresh-scan",
    normalized_url: normalizedUrl,
    billable: true,
    cached_result: null,
  };
};

const emitDeepScanProgress = ({
  job_id,
  user_id,
  lead_id,
  normalized_url,
  status,
  emails_found = 0,
  phones_found = 0,
  cached = false,
  attempt = 0,
  max_attempts = DEEP_SCAN_MAX_ATTEMPTS,
}) => {
  try {
    getIO().to(`user:${user_id}`).emit("scrape:deepscan", {
      event: "scrape:deepscan",
      job_id,
      user_id,
      lead_id,
      normalized_url,
      status,
      emails_found,
      phones_found,
      cached,
      attempt,
      max_attempts,
      ts: Date.now(),
    });
  } catch {
    // websocket is best effort
  }
};

const buildFetchConfig = ({ attempt, useProxy }) => {
  const config = {
    timeout: DEEP_SCAN_TIMEOUT_MS,
    maxRedirects: DEEP_SCAN_MAX_REDIRECTS,
    maxContentLength: DEEP_SCAN_MAX_CONTENT_BYTES,
    responseType: "text",
    responseEncoding: "utf8",
    validateStatus: (status) => status >= 200 && status < 300,
    headers: {
      "User-Agent":
        process.env.DEEP_SCAN_USER_AGENT ||
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
    },
    beforeRedirect: async (options) => {
      const nextUrl = `${options.protocol}//${options.hostname}${options.path || "/"}`;
      const safe = await validateUrlSafeToFetch(nextUrl);
      if (!safe.safe) {
        throw Object.assign(new Error(`Blocked unsafe redirect: ${safe.reason}`), {
          code: "DEEP_SCAN_BLOCKED_REDIRECT",
        });
      }
    },
    metadata: { attempt },
  };

  if (useProxy) {
    const proxyConfig = getNextProxyConfig();
    const proxyAgent = new HttpsProxyAgent(proxyConfigToUrl(proxyConfig));
    config.httpsAgent = proxyAgent;
    config.httpAgent = proxyAgent;
    config.proxy = false;
  }

  return config;
};

const fetchPage = async (url, { attempt, axiosClient = axios } = {}) => {
  try {
    return await axiosClient.get(
      url,
      buildFetchConfig({ attempt, useProxy: true }),
    );
  } catch (error) {
    if (!shouldRetryDeepScanWithoutProxy(error, { proxyUsed: true })) {
      throw error;
    }

    logDeepScan("deep_scan_direct_fallback", {
      normalized_url: normalizeDeepScanUrl(url),
      status: "RETRYING_DIRECT",
      reason: error?.message || "proxy-blocked",
    });

    return axiosClient.get(
      url,
      buildFetchConfig({ attempt, useProxy: false }),
    );
  }
};

export const deepScanUrl = async (url, options = {}) => {
  const startedAt = Date.now();
  const normalizedUrl = normalizeDeepScanUrl(url);
  const jobId = options.job_id || options.jobId || null;
  const userId = options.user_id || options.userId || null;
  const leadId = options.lead_id || options.leadId || null;
  const resultModel = options.resultModel || DeepScanResult;

  if (!normalizedUrl) {
    return makeResultPayload({
      normalizedUrl: null,
      rootDomain: null,
      status: "BLOCKED",
      errorType: "InvalidUrl",
      errorMessage: "Invalid or unsupported URL",
    });
  }

  const rootDomain = getRootDomain(new URL(normalizedUrl).hostname);

  if (shouldSkipDeepScanDomain(normalizedUrl)) {
    const skipped = makeResultPayload({ normalizedUrl, rootDomain, status: "SKIPPED" });
    await persistResult({ result: skipped, leadIds: [leadId], resultModel });
    logDeepScan("deep_scan_skipped", {
      job_id: jobId,
      user_id: userId,
      normalized_url: normalizedUrl,
      root_domain: rootDomain,
      status: "SKIPPED",
      elapsed_ms: Date.now() - startedAt,
    });
    return skipped;
  }

  const cached =
    options.cache !== false
      ? await getCachedDeepScanResult(normalizedUrl, resultModel)
      : null;
  if (cached) {
    logDeepScan("deep_scan_cache_hit", {
      job_id: jobId,
      user_id: userId,
      normalized_url: normalizedUrl,
      root_domain: rootDomain,
      status: cached.status,
      elapsed_ms: Date.now() - startedAt,
    });
    emitDeepScanProgress({
      job_id: jobId,
      user_id: userId,
      lead_id: leadId,
      normalized_url: normalizedUrl,
      status: cached.status,
      emails_found: cached.emails?.length || 0,
      phones_found: cached.phone_numbers?.length || 0,
      cached: true,
    });
    return toLegacyResult(cached, { cached: true });
  }

  const safety = await validateUrlSafeToFetch(normalizedUrl);
  if (!safety.safe) {
    const blocked = makeResultPayload({
      normalizedUrl,
      rootDomain,
      status: "BLOCKED",
      errorType: "BlockedUrl",
      errorMessage: safety.reason,
    });
    await persistResult({ result: blocked, leadIds: [leadId], resultModel });
    logDeepScan("deep_scan_blocked", {
      job_id: jobId,
      user_id: userId,
      normalized_url: normalizedUrl,
      root_domain: rootDomain,
      status: "BLOCKED",
      elapsed_ms: Date.now() - startedAt,
    });
    return blocked;
  }

  let acquiredDomainLock = false;
  if (!options.skipDomainLock) {
    while ((activeDomainLocks.get(rootDomain) || 0) >= DEEP_SCAN_CONCURRENCY_PER_DOMAIN) {
      await sleep(DEEP_SCAN_RETRY_DELAY_MS);
    }

    incrementLock(activeDomainLocks, rootDomain);
    acquiredDomainLock = true;
  }
  try {
    let lastError = null;
    for (let attempt = 1; attempt <= DEEP_SCAN_MAX_ATTEMPTS; attempt++) {
      try {
        logDeepScan("deep_scan_started", {
          job_id: jobId,
          user_id: userId,
          normalized_url: normalizedUrl,
          root_domain: rootDomain,
          attempt,
          status: "RUNNING",
        });

        const pages = [normalizedUrl];
        const aggregate = {
          emails: [],
          phone_numbers: [],
          contact_page_urls: [],
          html_title: null,
          http_status: null,
          final_url: normalizedUrl,
        };

        for (let pageIndex = 0; pageIndex < pages.length && pageIndex < DEEP_SCAN_MAX_PAGES_PER_DOMAIN; pageIndex++) {
          const pageUrl = pages[pageIndex];
          const pageSafety = await validateUrlSafeToFetch(pageUrl);
          if (!pageSafety.safe) continue;
          const response = await fetchPage(pageUrl, { attempt, axiosClient: options.axiosClient });
          const html = typeof response.data === "string" ? response.data : "";
          const extracted = extractDeepScanContactsFromHtml(html, pageUrl);
          aggregate.emails.push(...extracted.emails);
          aggregate.phone_numbers.push(...extracted.phone_numbers);
          aggregate.contact_page_urls.push(...extracted.contact_page_urls);
          aggregate.html_title ||= extracted.html_title;
          aggregate.http_status = response.status;
          aggregate.final_url = response.request?.res?.responseUrl || pageUrl;
          for (const contactUrl of extracted.contact_page_urls) {
            if (pages.length >= DEEP_SCAN_MAX_PAGES_PER_DOMAIN) break;
            if (!pages.includes(contactUrl)) pages.push(contactUrl);
          }
        }

        const result = makeResultPayload({
          normalizedUrl,
          finalUrl: aggregate.final_url,
          rootDomain,
          status: "SUCCEEDED",
          httpStatus: aggregate.http_status,
          emails: aggregate.emails,
          phoneNumbers: aggregate.phone_numbers,
          contactPageUrls: [...new Set(aggregate.contact_page_urls)].slice(0, DEEP_SCAN_MAX_PAGES_PER_DOMAIN - 1),
          htmlTitle: aggregate.html_title,
          scannedPagesCount: Math.min(pages.length, DEEP_SCAN_MAX_PAGES_PER_DOMAIN),
          attempts: attempt,
        });

        await persistResult({ result, leadIds: [leadId], resultModel });
        logDeepScan("deep_scan_succeeded", {
          job_id: jobId,
          user_id: userId,
          normalized_url: normalizedUrl,
          root_domain: rootDomain,
          attempt,
          status: "SUCCEEDED",
          emails_found: result.emails.length,
          phones_found: result.phone_numbers.length,
          elapsed_ms: Date.now() - startedAt,
        });
        return result;
      } catch (error) {
        lastError = error;
        if (attempt < DEEP_SCAN_MAX_ATTEMPTS && isDeepScanRetryableError(error)) {
          logDeepScan("deep_scan_proxy_retry", {
            job_id: jobId,
            user_id: userId,
            normalized_url: normalizedUrl,
            root_domain: rootDomain,
            attempt,
            status: "RETRYING",
            elapsed_ms: Date.now() - startedAt,
          });
          await sleep(options.retryDelayMs ?? DEEP_SCAN_RETRY_DELAY_MS);
          continue;
        }
        break;
      }
    }

    const failed = makeResultPayload({
      normalizedUrl,
      rootDomain,
      status: "FAILED",
      errorType: lastError?.name || lastError?.code || "DeepScanError",
      errorMessage: lastError?.message || "Deep scan failed",
      attempts: DEEP_SCAN_MAX_ATTEMPTS,
    });
    await persistResult({ result: failed, leadIds: [leadId], resultModel });
    logDeepScan("deep_scan_failed", {
      job_id: jobId,
      user_id: userId,
      normalized_url: normalizedUrl,
      root_domain: rootDomain,
      attempt: DEEP_SCAN_MAX_ATTEMPTS,
      status: "FAILED",
      elapsed_ms: Date.now() - startedAt,
    });
    return failed;
  } finally {
    if (acquiredDomainLock) {
      decrementLock(activeDomainLocks, rootDomain);
    }
  }
};

export const attachDeepScanResultToLeads = async ({
  result,
  leadIds = [],
  leadModel = Lead,
  resultModel = DeepScanResult,
}) => {
  const ids = [...new Set(leadIds.filter(Boolean).map(String))];
  if (!ids.length || !result?.normalized_url) return { matched: 0 };

  const persisted = await persistResult({ result, leadIds: ids, resultModel });

  if (typeof leadModel.bulkWrite === "function") {
    const operations = ids.map((leadId) => ({
      updateOne: {
        filter: { _id: leadId },
        update: {
          $set: {
            deep_scan_status: result.status,
            deep_scan_result_id: persisted._id,
          },
          $addToSet: {
            emails: { $each: normalizeEmails(result.emails || []) },
            phone_numbers: { $each: normalizePhones(result.phone_numbers || []) },
          },
        },
      },
    }));

    const bulkResult = await leadModel.bulkWrite(operations, { ordered: false });
    for (const leadId of ids) {
      logDeepScan("deep_scan_attached_to_lead", {
        lead_id: String(leadId),
        normalized_url: result.normalized_url,
        root_domain: result.root_domain,
        status: result.status,
        emails_found: result.emails?.length || 0,
        phones_found: result.phone_numbers?.length || 0,
      });
    }

    return {
      matched:
        bulkResult?.matchedCount ??
        bulkResult?.modifiedCount ??
        bulkResult?.result?.nMatched ??
        ids.length,
    };
  }

  for (const leadId of ids) {
    const lead = await leadModel.findById(leadId);
    if (!lead) continue;
    lead.emails = normalizeEmails([...(lead.emails || []), ...(result.emails || [])]);
    lead.phone_numbers = normalizePhones([...(lead.phone_numbers || []), ...(result.phone_numbers || [])]);
    lead.deep_scan_status = result.status;
    lead.deep_scan_result_id = persisted._id;
    await lead.save();
    logDeepScan("deep_scan_attached_to_lead", {
      lead_id: String(leadId),
      normalized_url: result.normalized_url,
      root_domain: result.root_domain,
      status: result.status,
      emails_found: result.emails?.length || 0,
      phones_found: result.phone_numbers?.length || 0,
    });
  }

  return { matched: ids.length };
};

const hashUrl = (normalizedUrl) =>
  crypto.createHash("sha256").update(normalizedUrl).digest("hex").slice(0, 32);

export const buildDeepScanQueueJobId = (normalizedUrl) =>
  `deep-scan:${hashUrl(normalizedUrl)}`;

const getDeepScanQueue = () => {
  if (!deepScanQueue) {
    deepScanQueue = new Queue(DEEP_SCAN_QUEUE_NAME, {
      connection: getRedisConnectionOptions({
        connectionName: "deep-scan-queue",
      }),
      prefix: DEEP_SCAN_QUEUE_PREFIX,
      defaultJobOptions: {
        attempts: DEEP_SCAN_MAX_ATTEMPTS,
        backoff: { type: "exponential", delay: DEEP_SCAN_RETRY_DELAY_MS },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86400, count: 1000 },
      },
    });
  }
  return deepScanQueue;
};

const getDeepScanQueueEvents = () => {
  if (!deepScanQueueEvents) {
    deepScanQueueEvents = new QueueEvents(DEEP_SCAN_QUEUE_NAME, {
      connection: getRedisConnectionOptions({
        connectionName: "deep-scan-queue-events",
      }),
      prefix: DEEP_SCAN_QUEUE_PREFIX,
    });
    deepScanQueueEvents.on("error", (error) => {
      console.error(
        `[DeepScan] Queue events error: ${error?.message || "unknown-error"}`,
      );
      captureException(
        error,
        bindErrorContext({
          tags: { area: "deep-scan", event: "queue-events-error" },
        }),
      );
    });
  }

  return deepScanQueueEvents;
};

export const enqueueDeepScanForLead = async ({ user_id, lead_id, url, job_id, username = null }) => {
  if (!DEEP_SCAN_ENABLED) return { queued: false, reason: "deep-scan-disabled" };
  const normalizedUrl = normalizeDeepScanUrl(url);
  if (!normalizedUrl) return { queued: false, reason: "invalid-url" };

  const rootDomain = getRootDomain(new URL(normalizedUrl).hostname);
  const addToSet = {};
  if (lead_id) addToSet.source_lead_ids = lead_id;
  if (username) addToSet.source_usernames = username;
  const result = await DeepScanResult.findOneAndUpdate(
    { normalized_url: normalizedUrl },
    {
      $setOnInsert: {
        normalized_url: normalizedUrl,
        root_domain: rootDomain,
        status: "PENDING",
      },
      ...(Object.keys(addToSet).length ? { $addToSet: addToSet } : {}),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  const queue = getDeepScanQueue();
  const queueJob = await queue.add(
    "deep-scan-url",
    { user_id, lead_id, url: normalizedUrl, job_id },
    { jobId: buildDeepScanQueueJobId(normalizedUrl) },
  );

  logDeepScan("deep_scan_enqueued", {
    job_id,
    user_id,
    lead_id,
    normalized_url: normalizedUrl,
    root_domain: rootDomain,
    status: result.status,
  });

  return { queued: true, job: queueJob, result };
};

export const enqueueDeepScanBatch = async ({ user_id, lead_ids = [], urls = [], job_id }) => {
  const tasks = [];
  for (let index = 0; index < urls.length; index++) {
    tasks.push(
      enqueueDeepScanForLead({
        user_id,
        lead_id: lead_ids[index] || null,
        url: urls[index],
        job_id,
      }),
    );
  }
  const results = await Promise.allSettled(tasks);
  return {
    requested: urls.length,
    queued: results.filter((result) => result.status === "fulfilled" && result.value.queued).length,
  };
};

export const processDeepScanJob = async (job, token) => {
  return withMonitoringSpan(
    "queue.deepScan.process",
    {
      op: "queue.process",
      attributes: {
        "queue.name": DEEP_SCAN_QUEUE_NAME,
        "queue.job_id": job?.id || null,
        "user.id": job?.data?.user_id || null,
        "lead.id": job?.data?.lead_id || null,
        "url.normalized": normalizeDeepScanUrl(job?.data?.url) || null,
      },
    },
    async () => {
      const { url, user_id, lead_id, job_id } = job.data || {};
      const normalizedUrl = normalizeDeepScanUrl(url);
      const isolation = await tryAcquireDeepScanIsolation({ user_id, url });
      if (!isolation.acquired) {
        await job.moveToDelayed(Date.now() + DEEP_SCAN_RETRY_DELAY_MS, token);
        logDeepScan("deep_scan_delayed_for_isolation", {
          job_id,
          user_id,
          normalized_url: isolation.normalized_url,
          root_domain: isolation.root_domain,
          status: "DELAYED",
          reason: isolation.reason,
          elapsed_ms: 0,
        });
        throw new DelayedError();
      }

      try {
        if (normalizedUrl) {
          await DeepScanResult.findOneAndUpdate(
            { normalized_url: normalizedUrl },
            {
              $set: {
                status: "RUNNING",
                error_type: null,
                error_message: null,
              },
            },
          );
        }

        const result = await deepScanUrl(url, {
          user_id,
          lead_id,
          job_id,
          retryDelayMs: DEEP_SCAN_RETRY_DELAY_MS,
          skipDomainLock: true,
        });
        const persisted = normalizedUrl
          ? await DeepScanResult.findOne({ normalized_url: normalizedUrl }).lean()
          : null;
        const relatedLeadIds = persisted?.source_lead_ids?.length
          ? persisted.source_lead_ids
          : [lead_id];

        await attachDeepScanResultToLeads({ result, leadIds: relatedLeadIds });
        emitDeepScanProgress({
          job_id,
          user_id,
          lead_id,
          normalized_url: result.normalized_url,
          status: result.status,
          emails_found: result.emails?.length || 0,
          phones_found: result.phone_numbers?.length || 0,
        });
        return result;
      } finally {
        await isolation.release();
      }
    },
  );
};

export const createDeepScanWorker = () => {
  if (!DEEP_SCAN_ENABLED) return null;
  if (deepScanWorker) return deepScanWorker;
  getDeepScanQueue();
  getDeepScanQueueEvents();

  deepScanWorker = new Worker(DEEP_SCAN_QUEUE_NAME, processDeepScanJob, {
    connection: getRedisConnectionOptions({
      connectionName: "deep-scan-worker",
    }),
    prefix: DEEP_SCAN_QUEUE_PREFIX,
    concurrency: DEEP_SCAN_CONCURRENCY_GLOBAL,
  });
  deepScanWorker.on("error", (error) => {
    console.error(`[DeepScan] Worker error: ${error?.message || "unknown-error"}`);
    captureException(
      error,
      bindErrorContext({
        tags: { area: "deep-scan", event: "worker-error" },
      }),
    );
  });
  deepScanWorker.on("failed", (job, error) => {
    captureException(
      error,
      bindErrorContext({
        tags: {
          area: "deep-scan",
          event: "job-failed",
          queue: DEEP_SCAN_QUEUE_NAME,
          job_id: job?.id || null,
        },
        extra: {
          user_id: job?.data?.user_id || null,
          lead_id: job?.data?.lead_id || null,
          url: job?.data?.url || null,
          attempts_made: job?.attemptsMade || 0,
        },
      }),
    );
  });
  return deepScanWorker;
};

export const deepScanExternalUrl = async (url, options = {}) =>
  toLegacyResult(await deepScanUrl(url, options));

export default {
  deepScanUrl,
  deepScanExternalUrl,
  previewDeepScanRequest,
  enqueueDeepScanForLead,
  enqueueDeepScanBatch,
  processDeepScanJob,
  normalizeDeepScanUrl,
  shouldSkipDeepScanDomain,
  validateUrlSafeToFetch,
  isPrivateOrInternalIp,
  isDeepScanRetryableError,
  discoverContactPageUrls,
  extractDeepScanContactsFromHtml,
  buildDeepScanQueueJobId,
  getDeepScanIsolationKeys,
  tryAcquireDeepScanIsolation,
  createDeepScanWorker,
};
