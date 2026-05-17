import axios from "axios";
import * as cheerio from "cheerio";
import { ApifyClient } from "apify-client";
import { CheerioCrawler, ProxyConfiguration } from "crawlee";
import puppeteer from "puppeteer";
import Lead from "../models/lead.model.js";
import { extractEmails, extractPhones } from "../utils/extractor.js";
import { HttpsProxyAgent } from "https-proxy-agent";
import fs from "fs";
import path from "path";
import { logMemoryUsage, MemoryTracker } from "../utils/memoryMonitor.js";
import accountPool from "./accountPoolService.js";
import {
  refundUnusedScrapedProfileCredits,
  reserveScrapedProfileCredits,
} from "./scrapeCreditService.js";
import userLeadService from "./userLeadService.js";
import { getIO } from "../websockets/index.js";
import { instagramConfig, requireProxyConfig } from "../config/instagram.js";
import {
  normalizeRelationshipRequestType,
  relationshipScrapeTitle,
  toRelationshipDirection,
} from "./instagram/relationshipTypes.js";
import { RELATIONSHIP_PROVIDER_TYPES } from "./instagram/providers/providerTypes.js";
import { ProviderUnsupportedOperationError } from "./instagram/errors.js";
import {
  DEEP_SCAN_INLINE_SINGLE_PROFILE,
  DEEP_SCAN_RELATIONSHIP_ENABLED,
  deepScanExternalUrl as queuedDeepScanExternalUrl,
  enqueueDeepScanBatch,
} from "./deepScanService.js";
import {
  createApifyRelationshipScrapeJob,
  processApifyRelationshipWebhook,
  startQueuedApifyRelationshipJob,
} from "./instagram/apifyRelationshipRunService.js";

// ═══════════════════════════════════════════════════════════════════════════
// Proxy Configuration (Residential Rotating Proxies)
// ═══════════════════════════════════════════════════════════════════════════
let currentProxyIndex = 0;

const clampNumber = (value, min, max, fallback) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const GRAPHQL_PAGE_SIZE = clampNumber(
  process.env.INSTAGRAM_GRAPHQL_PAGE_SIZE,
  25,
  100,
  100,
);
// Hardcoded max 50 per query for followers/following relationship scraping
const GRAPHQL_RELATIONSHIP_PAGE_SIZE = 50;
const INSTAGRAM_JSON_RETRIES = clampNumber(
  process.env.INSTAGRAM_JSON_RETRIES,
  0,
  3,
  1,
);
const TARGET_PROFILE_CACHE_TTL_MS = clampNumber(
  process.env.INSTAGRAM_TARGET_PROFILE_CACHE_TTL_MS,
  60_000,
  24 * 60 * 60 * 1000,
  6 * 60 * 60 * 1000,
);
const PROFILE_DETAIL_CONCURRENCY = clampNumber(
  process.env.INSTAGRAM_PROFILE_DETAIL_CONCURRENCY,
  1,
  4,
  1,
);
const PROFILE_DETAIL_BATCH_DELAY_MIN_MS = clampNumber(
  process.env.INSTAGRAM_PROFILE_DETAIL_BATCH_DELAY_MIN_MS,
  0,
  120_000,
  30_000,
);
const PROFILE_DETAIL_BATCH_DELAY_MAX_MS = clampNumber(
  process.env.INSTAGRAM_PROFILE_DETAIL_BATCH_DELAY_MAX_MS,
  PROFILE_DETAIL_BATCH_DELAY_MIN_MS,
  180_000,
  45_000,
);
const PROFILE_DETAIL_RATE_LIMIT_MAX_ATTEMPTS = clampNumber(
  process.env.INSTAGRAM_PROFILE_DETAIL_RATE_LIMIT_MAX_ATTEMPTS,
  1,
  8,
  4,
);
const PROFILE_DETAIL_RATE_LIMIT_BACKOFF_BASE_MS = clampNumber(
  process.env.INSTAGRAM_PROFILE_DETAIL_RATE_LIMIT_BACKOFF_BASE_MS,
  30_000,
  30 * 60 * 1000,
  2 * 60 * 1000,
);
const PROFILE_DETAIL_RATE_LIMIT_BACKOFF_MAX_MS = clampNumber(
  process.env.INSTAGRAM_PROFILE_DETAIL_RATE_LIMIT_BACKOFF_MAX_MS,
  PROFILE_DETAIL_RATE_LIMIT_BACKOFF_BASE_MS,
  60 * 60 * 1000,
  15 * 60 * 1000,
);
const GRAPHQL_RESULT_PREVIEW_LIMIT = clampNumber(
  process.env.INSTAGRAM_GRAPHQL_RESULT_PREVIEW_LIMIT,
  0,
  1000,
  200,
);
const APIFY_PROFILE_CHUNK_SIZE = clampNumber(
  process.env.APIFY_PROFILE_CHUNK_SIZE,
  1,
  1000,
  50,
);
const APIFY_PROFILE_MAX_CHUNK_SIZE = clampNumber(
  process.env.APIFY_PROFILE_MAX_CHUNK_SIZE,
  APIFY_PROFILE_CHUNK_SIZE,
  1000,
  500,
);
const APIFY_PROFILE_MIN_AVG_INPUT_PER_RUN = clampNumber(
  process.env.APIFY_PROFILE_MIN_AVG_INPUT_PER_RUN,
  1,
  1000,
  50,
);
const APIFY_PROFILE_ESTIMATED_COST_PER_ITEM_USD = Number.parseFloat(
  process.env.APIFY_PROFILE_ESTIMATED_COST_PER_ITEM_USD || "0.002",
);
const APIFY_PROFILE_BUDGET_USD = Number.parseFloat(
  process.env.APIFY_PROFILE_BUDGET_USD || "0",
);
const APIFY_INSTAGRAM_PROFILE_ACTOR_ID = instagramConfig.apify.actorId;
const targetProfileCache = new Map();
let apifyProfileClient = null;

const getErrorStatus = (error) =>
  error?.response?.status ??
  error?.response?.statusCode ??
  error?.statusCode ??
  error?.status ??
  null;

const isRateLimitStatus = (status) => status === 429 || status === 418;
const isAuthStatus = (status) => status === 401 || status === 403;

const isRateLimitError = (error) => {
  const status = getErrorStatus(error);
  const message = String(error?.message || "").toLowerCase();
  return (
    isRateLimitStatus(status) ||
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("received 429")
  );
};

const isAuthError = (error) => {
  const status = getErrorStatus(error);
  const message = String(error?.message || "").toLowerCase();
  return (
    isAuthStatus(status) ||
    message.includes("received 401") ||
    message.includes("received 403") ||
    message.includes("login_required") ||
    message.includes("session may have expired")
  );
};

const targetProfileCacheKey = (username) => String(username || "").toLowerCase();

const getCachedTargetProfile = (username, { allowStale = false } = {}) => {
  const key = targetProfileCacheKey(username);
  const cached = targetProfileCache.get(key);
  if (!cached) return null;

  if (!allowStale && Date.now() - cached.cachedAt > TARGET_PROFILE_CACHE_TTL_MS) {
    targetProfileCache.delete(key);
    return null;
  }

  return cached.profile;
};

const setCachedTargetProfile = (username, profile) => {
  if (!username || !profile?.id) return;
  targetProfileCache.set(targetProfileCacheKey(username), {
    profile,
    cachedAt: Date.now(),
  });
};

const getApifyProfileClient = () => {
  if (apifyProfileClient) return apifyProfileClient;
  if (!instagramConfig.apify.token) {
    throw new Error(t('APIFY_API_KEY not configured in environment variables'));
  }
  apifyProfileClient = new ApifyClient({ token: instagramConfig.apify.token });
  return apifyProfileClient;
};

const normalizeJobType = (value) => {
  const normalized = String(value || "single_profile").trim().toLowerCase();
  if (["single_profile", "bulk_profiles", "followers", "following"].includes(normalized)) {
    return normalized;
  }
  return "single_profile";
};

const resolveRelationshipProvider = ({ provider, withGraphQl } = {}) => {
  const normalizedProvider = String(provider || "")
    .trim()
    .toLowerCase();

  if (
    normalizedProvider === RELATIONSHIP_PROVIDER_TYPES.GRAPHQL ||
    normalizedProvider === RELATIONSHIP_PROVIDER_TYPES.PUPPETEER ||
    normalizedProvider === RELATIONSHIP_PROVIDER_TYPES.APIFY
  ) {
    return normalizedProvider;
  }

  return withGraphQl
    ? RELATIONSHIP_PROVIDER_TYPES.GRAPHQL
    : RELATIONSHIP_PROVIDER_TYPES.PUPPETEER;
};

const normalizeAndDedupeUsernames = (usernames = []) => {
  const out = [];
  const seen = new Set();

  for (const entry of usernames) {
    const normalized = String(entry || "")
      .trim()
      .replace(/^@+/, "")
      .toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }

  return out;
};

const chunkUsernames = (usernames, chunkSize) => {
  const chunks = [];
  const safeChunkSize = Math.max(1, Number.parseInt(chunkSize, 10) || 1);

  for (let index = 0; index < usernames.length; index += safeChunkSize) {
    chunks.push(usernames.slice(index, index + safeChunkSize));
  }

  return chunks;
};

const estimateApifyCost = (inputCount) =>
  Number(
    (
      Math.max(0, Number(inputCount) || 0) *
      (Number.isFinite(APIFY_PROFILE_ESTIMATED_COST_PER_ITEM_USD)
        ? APIFY_PROFILE_ESTIMATED_COST_PER_ITEM_USD
        : 0.002)
    ).toFixed(6),
  );

const createApifyMetrics = ({ context, inputCount }) => ({
  context,
  input_count_total: inputCount,
  apify_runs_count: 0,
  apify_input_count_total: 0,
  apify_cost_estimate_total: 0,
  apify_single_run_count: 0,
});

const finalizeApifyMetrics = (metrics) => {
  const avgInput =
    metrics.apify_runs_count > 0
      ? Number((metrics.apify_input_count_total / metrics.apify_runs_count).toFixed(2))
      : 0;
  const costPerProfile =
    metrics.apify_input_count_total > 0
      ? Number(
          (metrics.apify_cost_estimate_total / metrics.apify_input_count_total).toFixed(6),
        )
      : 0;

  const snapshot = {
    apify_runs_count: metrics.apify_runs_count,
    apify_input_count_total: metrics.apify_input_count_total,
    apify_avg_input_per_run: avgInput,
    apify_cost_estimate_total: Number(metrics.apify_cost_estimate_total.toFixed(6)),
    apify_cost_per_profile: costPerProfile,
    apify_single_run_count: metrics.apify_single_run_count,
  };

  const jobType = normalizeJobType(metrics?.context?.jobType);
  if (
    ["bulk_profiles", "followers", "following"].includes(jobType) &&
    snapshot.apify_runs_count > 0 &&
    snapshot.apify_avg_input_per_run < APIFY_PROFILE_MIN_AVG_INPUT_PER_RUN
  ) {
    console.warn(
      `[HIGH][ApifyMetrics] job_type=${jobType} job_id=${metrics?.context?.jobId || "n/a"} avg_input_per_run=${snapshot.apify_avg_input_per_run} threshold=${APIFY_PROFILE_MIN_AVG_INPUT_PER_RUN}`,
    );
  }

  return snapshot;
};

const buildApifyEnrichmentPlan = ({
  usernames,
  context,
  chunkSize = APIFY_PROFILE_CHUNK_SIZE,
  maxChunkSize = APIFY_PROFILE_MAX_CHUNK_SIZE,
  cachedUsernames = [],
  budgetUsd,
  allowSingleAsFinalLeftover = false,
}) => {
  const normalizedContext = {
    jobType: normalizeJobType(context?.jobType),
    jobId: context?.jobId || null,
    userId: context?.userId || null,
  };

  const dedupedUsernames = normalizeAndDedupeUsernames(usernames);
  const cachedSet = new Set(normalizeAndDedupeUsernames(cachedUsernames));
  const uncachedUsernames = dedupedUsernames.filter((username) => !cachedSet.has(username));

  const safeChunkSize = Math.max(
    1,
    Math.min(
      Number.parseInt(chunkSize, 10) || APIFY_PROFILE_CHUNK_SIZE,
      Number.parseInt(maxChunkSize, 10) || APIFY_PROFILE_MAX_CHUNK_SIZE,
    ),
  );

  const estimatedCost = estimateApifyCost(uncachedUsernames.length);
  const effectiveBudget =
    Number.isFinite(Number(budgetUsd)) && Number(budgetUsd) > 0
      ? Number(budgetUsd)
      : Number.isFinite(APIFY_PROFILE_BUDGET_USD) && APIFY_PROFILE_BUDGET_USD > 0
        ? APIFY_PROFILE_BUDGET_USD
        : 0;

  if (effectiveBudget > 0 && estimatedCost > effectiveBudget) {
    return {
      context: normalizedContext,
      dedupedUsernames,
      uncachedUsernames,
      chunks: [],
      estimatedCost,
      budgetUsd: effectiveBudget,
      stage: "SKIPPED_COST_LIMIT",
    };
  }

  const chunks = chunkUsernames(uncachedUsernames, safeChunkSize);

  if (
    ["followers", "following", "bulk_profiles"].includes(normalizedContext.jobType) &&
    uncachedUsernames.length === 1 &&
    !allowSingleAsFinalLeftover
  ) {
    throw new Error(
      "Apify single-profile enrichment called inside relationship job. This is inefficient. Use batch enrichment.",
    );
  }

  return {
    context: normalizedContext,
    dedupedUsernames,
    uncachedUsernames,
    chunks,
    estimatedCost,
    budgetUsd: effectiveBudget,
    stage: "READY",
  };
};

const buildApifyInput = (usernames) => ({
  usernames: usernames.map((username) => `https://www.instagram.com/${username}/`),
});

const runApifyProfileChunk = async ({ usernames, chunkIndex, context }) => {
  const actorId = APIFY_INSTAGRAM_PROFILE_ACTOR_ID;
  const estimatedCost = estimateApifyCost(usernames.length);
  const startedAt = Date.now();

  console.log(
    JSON.stringify({
      event: "apify_profile_chunk_started",
      provider: "apify",
      actor_id: actorId,
      job_id: context?.jobId || null,
      user_id: context?.userId || null,
      job_type: context?.jobType || null,
      chunk_index: chunkIndex,
      input_count: usernames.length,
      estimated_cost: estimatedCost,
    }),
  );

  const client = getApifyProfileClient();
  const run = await client.actor(actorId).call(buildApifyInput(usernames), {
    waitSecs: 300,
  });
  const { items = [] } = await client.dataset(run.defaultDatasetId).listItems({
    clean: true,
  });

  console.log(
    JSON.stringify({
      event: "apify_profile_enrichment_finished",
      provider: "apify",
      job_id: context?.jobId || null,
      user_id: context?.userId || null,
      job_type: context?.jobType || null,
      chunk_index: chunkIndex,
      input_count: usernames.length,
      output_count: Array.isArray(items) ? items.length : 0,
      estimated_cost: estimatedCost,
      elapsed_ms: Date.now() - startedAt,
    }),
  );

  emitScrapeRealtime({
    userId: context?.userId || null,
    event: "scrape:enriched_profile_count",
    payload: {
      job_id: context?.jobId || null,
      job_type: context?.jobType || null,
      chunk_index: chunkIndex,
      enriched_profile_count: Array.isArray(items) ? items.length : 0,
    },
    label: "Apify Profile Enrichment",
  });

  return { run, items, estimatedCost };
};

const mapApifyItemToProfileSnapshot = (item) => ({
  id: item?.id ?? null,
  username: String(item?.username || "").trim().toLowerCase() || null,
  fullName: item?.fullName ?? item?.full_name ?? null,
  biography: item?.biography ?? item?.bio ?? null,
  followersCount: parseCount(item?.followersCount ?? item?.followers_count),
  followsCount: parseCount(item?.followsCount ?? item?.following_count),
  postsCount: parseCount(item?.postsCount ?? item?.posts_count),
  profilePicUrl: item?.profilePicUrl ?? item?.profile_pic_url ?? null,
  profilePicUrlHD: item?.profilePicUrlHD ?? item?.profile_pic_url_hd ?? null,
  externalUrl: item?.externalUrl ?? item?.external_url ?? null,
  businessCategoryName: item?.businessCategoryName ?? item?.category_name ?? null,
  verified: Boolean(item?.verified ?? item?.is_verified),
  private: Boolean(item?.private ?? item?.is_private),
});

const enrichProfiles = async (usernames, options = {}) => {
  const context = {
    jobType: normalizeJobType(options?.context?.jobType),
    jobId: options?.context?.jobId || null,
    userId: options?.context?.userId || null,
  };

  const plan = buildApifyEnrichmentPlan({
    usernames,
    context,
    chunkSize: options.chunkSize,
    maxChunkSize: options.maxChunkSize,
    cachedUsernames: options.cachedUsernames,
    budgetUsd: options.budgetUsd,
    allowSingleAsFinalLeftover: Boolean(options.allowSingleAsFinalLeftover),
  });

  const metrics = createApifyMetrics({
    context,
    inputCount: plan.uncachedUsernames.length,
  });

  if (plan.stage === "SKIPPED_COST_LIMIT") {
    return {
      stage: "SKIPPED_COST_LIMIT",
      reason: "apify-cost-limit-exceeded",
      estimatedCost: plan.estimatedCost,
      budgetUsd: plan.budgetUsd,
      profiles: [],
      metrics: finalizeApifyMetrics(metrics),
    };
  }

  const profileByUsername = new Map();

  for (let chunkIndex = 0; chunkIndex < plan.chunks.length; chunkIndex++) {
    const chunk = plan.chunks[chunkIndex];

    // Hard guardrail: relationship jobs can only run a 1-item chunk as final leftover.
    if (
      ["followers", "following"].includes(context.jobType) &&
      chunk.length === 1 &&
      !(chunkIndex === plan.chunks.length - 1 && plan.chunks.length > 1)
    ) {
      throw new Error(
        "Apify single-profile enrichment called inside relationship job. This is inefficient. Use batch enrichment.",
      );
    }

    const { items, estimatedCost } = await runApifyProfileChunk({
      usernames: chunk,
      chunkIndex,
      context,
    });

    const rssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
    const highMemoryRssMb = clampNumber(
      process.env.APIFY_ENRICHMENT_HIGH_RSS_MB,
      128,
      4096,
      220,
    );
    if (rssMb >= highMemoryRssMb) {
      console.warn(
        JSON.stringify({
          event: "apify_enrichment_high_memory",
          severity: "high",
          job_id: context?.jobId || null,
          user_id: context?.userId || null,
          job_type: context?.jobType || null,
          rss_mb: rssMb,
          threshold_mb: highMemoryRssMb,
          action: "continuing_sequential_chunks_and_flushing_per_chunk",
        }),
      );
    }

    metrics.apify_runs_count += 1;
    metrics.apify_input_count_total += chunk.length;
    metrics.apify_cost_estimate_total += estimatedCost;
    if (chunk.length === 1) {
      metrics.apify_single_run_count += 1;
    }

    for (const item of items || []) {
      const mapped = mapApifyItemToProfileSnapshot(item);
      if (!mapped.username) continue;
      if (!profileByUsername.has(mapped.username)) {
        profileByUsername.set(mapped.username, mapped);
      }
    }

    if (typeof options.onChunkComplete === "function") {
      try {
        await options.onChunkComplete({
          chunkIndex,
          inputCount: chunk.length,
          outputCount: (items || []).length,
          context,
          metricsSnapshot: {
            apify_runs_count: metrics.apify_runs_count,
            apify_input_count_total: metrics.apify_input_count_total,
            apify_cost_estimate_total: Number(metrics.apify_cost_estimate_total.toFixed(6)),
          },
        });
      } catch (callbackError) {
        console.warn(
          `[Apify] onChunkComplete failed (non-fatal): ${callbackError.message}`,
        );
      }
    }
  }

  return {
    stage: "COMPLETED",
    profiles: Array.from(profileByUsername.values()),
    profileByUsername,
    estimatedCost: plan.estimatedCost,
    metrics: finalizeApifyMetrics(metrics),
  };
};

const enrichProfile = async (username, options = {}) => {
  const context = {
    jobType: normalizeJobType(options?.context?.jobType),
    jobId: options?.context?.jobId || null,
    userId: options?.context?.userId || null,
  };

  if (context.jobType !== "single_profile") {
    console.warn(
      "Apify single-profile enrichment called inside relationship job. This is inefficient. Use batch enrichment.",
    );
    const batchResult = await enrichProfiles([username], {
      ...options,
      context,
      allowSingleAsFinalLeftover: Boolean(options.allowSingleAsFinalLeftover),
    });
    return batchResult.profiles?.[0] || null;
  }

  const batchResult = await enrichProfiles([username], {
    ...options,
    context: {
      ...context,
      jobType: "single_profile",
    },
    allowSingleAsFinalLeftover: true,
  });

  return batchResult.profiles?.[0] || null;
};

/**
 * Get next proxy configuration for a scraping session.
 * Returns structured config object with host, port, username, password.
 * This ensures one proxy per session (no mid-session rotation).
 */
const getNextProxyConfig = () => {
  const proxyConfig = requireProxyConfig();
  const port = proxyConfig.ports[currentProxyIndex];
  currentProxyIndex = (currentProxyIndex + 1) % proxyConfig.ports.length;

  return {
    host: proxyConfig.host,
    port: port,
    username: proxyConfig.username,
    password: proxyConfig.password,
  };
};

/**
 * Convert proxy config object to URL string (for axios/HttpsProxyAgent).
 * Used by deep scan function.
 */
const proxyConfigToUrl = (config) => {
  const username = encodeURIComponent(config.username);
  const password = encodeURIComponent(config.password);
  return `http://${username}:${password}@${config.host}:${config.port}`;
};

const getAllProxyUrls = (forcedProxyConfig = null) => {
  if (forcedProxyConfig) {
    return [proxyConfigToUrl(forcedProxyConfig)];
  }

  const proxyConfig = requireProxyConfig();
  return proxyConfig.ports.map((port) =>
    proxyConfigToUrl({
      host: proxyConfig.host,
      port,
      username: proxyConfig.username,
      password: proxyConfig.password,
    }),
  );
};

const fetchJsonWithCheerioCrawler = async ({
  url,
  headers = {},
  label = "crawler-request",
  forcedProxyConfig = null,
  maxRequestRetries = INSTAGRAM_JSON_RETRIES,
  timeoutSecs = 30,
}) => {
  const proxyConfiguration = new ProxyConfiguration({
    proxyUrls: getAllProxyUrls(forcedProxyConfig),
  });

  let parsedJson = null;
  let lastCrawlerError = null;

  const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxConcurrency: 1,
    maxRequestRetries,
    requestHandlerTimeoutSecs: timeoutSecs,
    useSessionPool: true,
    persistCookiesPerSession: true,
    additionalMimeTypes: ["application/json", "text/plain"],
    async requestHandler({ body, response }) {
      const rawBody =
        typeof body === "string"
          ? body
          : Buffer.isBuffer(body)
            ? body.toString("utf8")
            : JSON.stringify(body);

      try {
        parsedJson = JSON.parse(rawBody);
      } catch (parseError) {
        const error = new Error(`[${label}] Invalid JSON response`);
        error.response = {
          status: response?.statusCode ?? null,
          headers: response?.headers ?? {},
        };
        throw error;
      }
    },
    async failedRequestHandler(context, error) {
      lastCrawlerError = error || context?.error;
    },
  });

  await crawler.run([
    {
      url,
      method: "GET",
      headers,
      uniqueKey: `${url}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    },
  ]);

  if (!parsedJson) {
    const status =
      lastCrawlerError?.statusCode ??
      lastCrawlerError?.response?.statusCode ??
      lastCrawlerError?.response?.status ??
      null;
    const headersFromError =
      lastCrawlerError?.response?.headers ??
      lastCrawlerError?.responseHeaders ??
      {};

    const error = new Error(
      `[${label}] Failed after retries: ${lastCrawlerError?.message ?? "unknown error"}`,
    );
    error.response = {
      status,
      headers: headersFromError,
    };
    if (isRateLimitStatus(status)) {
      error.name = "InstagramRateLimitError";
    } else if (isAuthStatus(status)) {
      error.name = "InstagramAuthError";
    }
    throw error;
  }

  return parsedJson;
};

// ═══════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════
const splitName = (fullName) => {
  if (!fullName || typeof fullName !== "string") {
    return { first_name: null, last_name: null };
  }
  const parts = fullName.trim().split(" ");
  return {
    first_name: parts[0] || null,
    last_name: parts.slice(1).join(" ") || null,
  };
};

const uniqueValues = (values) => [...new Set(values.filter(Boolean))];

const parseCount = (value) => {
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

const normalizeUrl = (url) => {
  if (!url || typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    return parsed.toString();
  } catch {
    return null;
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Deep Scan Function with Rotating Proxy
// ═══════════════════════════════════════════════════════════════════════════
// List of domains to skip during deep scan (social platforms, tech giants, etc.)
const SKIP_DOMAINS = [
  "apple.com",
  "youtube.com",
  "google.com",
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "tiktok.com",
  "snapchat.com",
  "pinterest.com",
  "reddit.com",
  "amazon.com",
  "ebay.com",
  "paypal.com",
  "github.com",
  "stackoverflow.com",
  "microsoft.com",
  "zoom.us",
  "discord.com",
  "telegram.org",
  "whatsapp.com",
  "spotify.com",
  "netflix.com",
  "t.co",
  "bit.ly",
  "tinyurl.com",
];

const shouldSkipDomain = (url) => {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase().replace(/^www\\./, "");

    // Check if hostname matches or ends with any skip domain
    return SKIP_DOMAINS.some((domain) => {
      return hostname === domain || hostname.endsWith("." + domain);
    });
  } catch (error) {
    return false;
  }
};

const deepScanExternalUrl = async (externalUrl, options = {}) =>
  queuedDeepScanExternalUrl(externalUrl, options);

const enqueueRelationshipDeepScans = ({
  user_id,
  job_id,
  leads = [],
  label = "Instagram",
}) => {
  if (!DEEP_SCAN_RELATIONSHIP_ENABLED || !leads.length) {
    return;
  }

  const scanTargets = leads
    .map((lead) => ({
      lead_id: lead?._id,
      url: lead?.external_url || lead?.external_urls?.[0] || null,
    }))
    .filter((target) => target.lead_id && target.url);

  if (!scanTargets.length) {
    return;
  }

  enqueueDeepScanBatch({
    user_id,
    job_id,
    lead_ids: scanTargets.map((target) => target.lead_id),
    urls: scanTargets.map((target) => target.url),
  }).catch((error) => {
    console.warn(`[DeepScan] ${label} enqueue failed: ${error.message}`);
  });
};

/*
const scrapeWithApify = async (username) => {
  const apifyToken = process.env.APIFY_API_KEY;
  if (!apifyToken) {
    throw new Error("APIFY_API_KEY not configured in environment variables");
  }

  const client = new ApifyClient({ token: apifyToken });

  console.log(`[Apify] Starting scrape for username: ${username}`);

  const input = {
    usernames: [`https://www.instagram.com/${username}/`],
  };

  try {
    const run = await client.actor(APIFY_INSTAGRAM_PROFILE_ACTOR_ID).call(input);
    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    if (!items || items.length === 0) {
      throw new Error("No data returned from Apify");
    }

    console.log("[Apify] Successfully scraped profile");
    return items[0];
  } catch (error) {
    console.log("[Apify] Error:", error.message);
    throw error;
  }
};

const scrapeWithApifyBulk = async (usernames) => {
  const apifyToken = process.env.APIFY_API_KEY;
  if (!apifyToken) {
    throw new Error("APIFY_API_KEY not configured in environment variables");
  }

  const client = new ApifyClient({ token: apifyToken });

  console.log(
    `[Apify Bulk] Starting bulk scrape for ${usernames.length} usernames`,
  );

  const instagramUrls = usernames.map(
    (username) => `https://www.instagram.com/${username}/`,
  );

  const input = {
    usernames: instagramUrls,
  };

  try {
    const run = await client.actor(APIFY_INSTAGRAM_PROFILE_ACTOR_ID).call(input);
    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    if (!items || items.length === 0) {
      throw new Error("No data returned from Apify bulk scrape");
    }

    console.log(`[Apify Bulk] Successfully scraped ${items.length} profiles`);
    return items;
  } catch (error) {
    console.log("[Apify Bulk] Error:", error.message);
    throw error;
  }
};
*/

// Legacy HTML scraper removed. Use scrapeWithInstagramAPI/scrapeWithInstagramAPIBulk.

// ═══════════════════════════════════════════════════════════════════════════
// Instagram JSON API Scraper (i.instagram.com)
// ═══════════════════════════════════════════════════════════════════════════
const scrapeWithInstagramAPI = async (
  username,
  cookieString = null,
  forcedProxyConfig = null,
  { maxRequestRetries = INSTAGRAM_JSON_RETRIES } = {},
) => {
  const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  // const url = `https://i.instagram.com/api/v1/users/${encodeURIComponent(username)}/usernameinfo`;
  // const url = `https://instagram.com/${encodeURIComponent(username)}/?__a=1&__d=dis`;
  const headers = {
    "User-Agent": "Instagram 219.0.0.12.117 Android",
    "X-IG-App-ID": "936619743392459",
    Accept: "application/json",
  };

  if (cookieString) {
    const csrftoken = cookieString.match(/csrftoken=([^;]+)/)?.[1];
    headers["Cookie"] = cookieString;
    if (csrftoken) headers["X-CSRFToken"] = csrftoken;
  }

  console.log(`[InstagramAPI] Fetching profile for @${username} via CheerioCrawler`);

  const responseData = await fetchJsonWithCheerioCrawler({
    url,
    headers,
    label: `instagram-profile-${username}`,
    forcedProxyConfig,
    maxRequestRetries,
    timeoutSecs: 30,
  });

  const user = responseData?.user ?? responseData?.data?.user ?? null;
  console.log(`[InstagramAPI] Received data for @${username}: ${user ? JSON.stringify(user) : "no user data"}`);
  if (!user)
    throw new Error(
      `No user data returned from Instagram API for @${username}`,
    );

  const bio = user.biography || "";
  const bioEmails = extractEmails(bio);
  const bioPhones = extractPhones(bio);

  if (user.business_email) bioEmails.push(user.business_email);
  if (user.business_phone_number) bioPhones.push(user.business_phone_number);

  // Collect external URLs
  const extUrls = (user.bio_links || []).map((l) => l.url).filter(Boolean);
  if (user.external_url && !extUrls.includes(user.external_url))
    extUrls.unshift(user.external_url);

  // Deep-scan external URLs for additional contacts
  let urlEmails = [];
  let urlPhones = [];
  if (DEEP_SCAN_INLINE_SINGLE_PROFILE && extUrls.length > 0) {
    console.log(
      `[InstagramAPI] @${username}: deep-scanning ${extUrls.length} external URL(s)...`,
    );
    for (const extUrl of extUrls) {
      try {
        const scan = await deepScanExternalUrl(extUrl);
        urlEmails.push(...(scan.emails ?? []));
        urlPhones.push(...(scan.phone_numbers ?? []));
      } catch (scanErr) {
        console.log(
          `[InstagramAPI] Deep-scan failed for ${extUrl}: ${scanErr.message}`,
        );
      }
    }
  }

  const allEmails = uniqueValues([...bioEmails, ...urlEmails]);
  const allPhones = uniqueValues([...bioPhones, ...urlPhones]);

  console.log(
    `[InstagramAPI] @${username} → ${allEmails.length} email(s), ${allPhones.length} phone(s)`,
  );

  return {
    id: user.id ?? null,
    username: user.username ?? username,
    fullName: user.full_name ?? null,
    biography: bio,
    followersCount: user.edge_followed_by?.count ?? null,
    followsCount: user.edge_follow?.count ?? null,
    postsCount: user.edge_owner_to_timeline_media?.count ?? null,
    profilePicUrl: user.profile_pic_url ?? null,
    profilePicUrlHD: user.profile_pic_url_hd ?? null,
    externalUrl: user.external_url ?? null,
    externalUrlShimmed: user.external_url_linkshimmed ?? null,
    externalUrls: extUrls.map((u) => ({ url: u })),
    verified: user.is_verified ?? false,
    private: user.is_private ?? false,
    businessCategoryName: user.business_category_name ?? null,
    emails: allEmails,
    phone_numbers: allPhones,
  };
};

// Bulk version of scrapeWithInstagramAPI
const scrapeWithInstagramAPIBulk = async (
  usernames,
  cookieString = null,
  options = {},
) => {
  const context = {
    jobType: normalizeJobType(options?.context?.jobType || "bulk_profiles"),
    jobId: options?.context?.jobId || null,
    userId: options?.context?.userId || null,
  };

  const enrichment = await enrichProfiles(usernames, {
    context,
    chunkSize: options.chunkSize || 50,
    maxChunkSize: options.maxChunkSize || 50,
    cachedUsernames: options.cachedUsernames,
    budgetUsd: options.budgetUsd,
    allowSingleAsFinalLeftover: Boolean(options.allowSingleAsFinalLeftover),
    onChunkComplete: options.onChunkComplete,
  });

  if (options.returnMeta) {
    return enrichment;
  }

  if (enrichment.stage === "SKIPPED_COST_LIMIT") {
    console.warn(
      `[InstagramAPI Bulk] Skipped due to cost limit (estimated=${enrichment.estimatedCost}, budget=${enrichment.budgetUsd})`,
    );
    return [];
  }

  return enrichment.profiles || [];
};

// ═══════════════════════════════════════════════════════════════════════════
// SteadyAPI Fallback
// ═══════════════════════════════════════════════════════════════════════════
const emitScrapeRealtime = ({
  userId,
  event,
  payload = {},
  label = "Instagram GraphQL",
}) => {
  if (!userId || !event) return;

  try {
    const io = getIO();
    io.to(`user:${userId}`).emit(event, {
      event,
      user_id: userId,
      ...payload,
      ts: Date.now(),
    });
  } catch (wsErr) {
    console.warn(`[${label}] WebSocket emit failed (non-fatal): ${wsErr.message}`);
  }
};

const parseRetryAfterMs = (retryAfterHeader) => {
  if (!retryAfterHeader) return null;

  const seconds = Number(retryAfterHeader);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(retryAfterHeader);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return null;
};

const getProfileDetailRateLimitDelayMs = (error, attempt) => {
  const retryAfterMs = parseRetryAfterMs(
    error?.response?.headers?.["retry-after"],
  );
  const exponentialMs =
    PROFILE_DETAIL_RATE_LIMIT_BACKOFF_BASE_MS *
    2 ** Math.max(0, attempt - 1);
  const cappedMs = Math.min(
    PROFILE_DETAIL_RATE_LIMIT_BACKOFF_MAX_MS,
    Math.max(retryAfterMs || 0, exponentialMs),
  );
  const jitterMs = Math.floor(Math.random() * 10_000);

  return cappedMs + jitterMs;
};

const delayAfterProfileDetailRequest = async () => {
  if (PROFILE_DETAIL_BATCH_DELAY_MAX_MS <= 0) return;
  await humanDelay(
    PROFILE_DETAIL_BATCH_DELAY_MIN_MS,
    PROFILE_DETAIL_BATCH_DELAY_MAX_MS,
  );
};

const mapGraphQLUserWithProfile = (user, profile = null, error = null) => ({
  id: profile?.id || user.id,
  username: profile?.username || user.username,
  followers: profile?.followersCount ?? null,
  following: profile?.followsCount ?? null,
  bio: profile?.biography || null,
  category: profile?.businessCategoryName || null,
  avatar: profile?.profilePicUrlHD || profile?.profilePicUrl || user.profile_pic_url,
  full_name: profile?.fullName || user.full_name || null,
  is_verified: profile?.verified ?? user.is_verified ?? false,
  is_private: profile?.private ?? user.is_private ?? false,
  external_url: profile?.externalUrl || null,
  posts_count: profile?.postsCount ?? null,
  emails: uniqueValues(profile?.emails || []),
  phone_numbers: uniqueValues(profile?.phone_numbers || []),
  ...(error ? { error: error.message } : {}),
});

const buildInstagramRelationshipLeadPayload = ({
  user,
  type,
  targetUsername,
  scrapingMethod = "GraphQL API",
}) => {
  const { first_name, last_name } = splitName(user.full_name || "");

  return {
    first_name,
    last_name,
    company: user.username || "",
    emails: user.emails || [],
    phone_numbers: user.phone_numbers || [],
    message: `
${relationshipScrapeTitle(type)} (${scrapingMethod})

Target Profile: @${targetUsername}
Username: @${user.username || "N/A"}
Full Name: ${user.full_name || "N/A"}
Bio: ${user.bio || "N/A"}
Followers: ${user.followers || "N/A"}
Following: ${user.following || "N/A"}
Posts: ${user.posts_count || "N/A"}
Verified: ${user.is_verified ? "Yes" : "No"}
Private: ${user.is_private ? "Yes" : "No"}
Category: ${user.category || "N/A"}
Profile URL: https://www.instagram.com/${user.username}
Scraping Method: ${scrapingMethod}
${user.emails && user.emails.length > 0 ? `Emails: ${user.emails.join(", ")}` : ""}
${user.phone_numbers && user.phone_numbers.length > 0 ? `Phone Numbers: ${user.phone_numbers.join(", ")}` : ""}
    `.trim(),
    scraped_from_username: targetUsername,
    relationship_type: toRelationshipDirection(type),
    source_url: `https://www.instagram.com/${user.username}`,
    source_rul: `https://www.instagram.com/${user.username}`,
    instagram_profile_id: user.id !== user.username ? user.id : null,
    username: user.username,
    full_name: user.full_name,
    bio: user.bio,
    avatar_url: user.avatar,
    avatar_rul: user.avatar,
    followers: user.followers,
    following: user.following,
    follower_count: user.followers,
    following_count: user.following,
    total_posts: user.posts_count,
    category: user.category,
    external_url: user.external_url,
    external_url_linkshimmed: null,
    external_urls: user.external_url ? [user.external_url] : [],
    is_private: user.is_private,
    is_verified: user.is_verified,
    is_public: user.is_private !== null ? !user.is_private : null,
    fb_profile_biolink: null,
    highlight_reel_count: null,
    links: [],
    scrape_status: !user.error,
    type: "INSTAGRAM",
  };
};

const fetchProfileDetailWithAdaptiveBackoff = async ({
  user,
  cookieString,
  sessionProxyConfig,
  batchNumber,
}) => {
  for (let attempt = 1; attempt <= PROFILE_DETAIL_RATE_LIMIT_MAX_ATTEMPTS; attempt++) {
    try {
      const profile = await scrapeWithInstagramAPI(
        user.username,
        cookieString,
        sessionProxyConfig,
        { maxRequestRetries: 0 },
      );
      return mapGraphQLUserWithProfile(user, profile);
    } catch (error) {
      if (isRateLimitError(error)) {
        if (attempt >= PROFILE_DETAIL_RATE_LIMIT_MAX_ATTEMPTS) {
          console.warn(
            `[Instagram GraphQL] Batch #${batchNumber}: web_profile_info still rate-limited for @${user.username} after ${attempt} attempt(s)`,
          );
          throw error;
        }

        const waitMs = getProfileDetailRateLimitDelayMs(error, attempt);
        console.warn(
          `[Instagram GraphQL] Batch #${batchNumber}: 429 while fetching @${user.username}; waiting ${Math.round(waitMs / 1000)}s before retry ${attempt + 1}/${PROFILE_DETAIL_RATE_LIMIT_MAX_ATTEMPTS}`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      if (isAuthError(error)) {
        throw error;
      }

      console.warn(
        `[Instagram GraphQL] web_profile_info failed for @${user.username}; using GraphQL fallback: ${error.message}`,
      );
      return mapGraphQLUserWithProfile(user, null, error);
    }
  }

  return mapGraphQLUserWithProfile(user, null);
};

const enrichGraphQLBatchWithInstagramAPI = async ({
  users,
  cookieString,
  sessionProxyConfig,
  batchNumber,
  relationshipType,
  jobId,
  userId,
  processedCountBeforeBatch = 0,
}) => {
  const enrichedUsers = [];
  const startedAt = Date.now();
  let chunksProcessedInBatch = 0;

  const queryName =
    relationshipType === "following"
      ? "edge_follow"
      : "edge_followed_by";

  console.log(
    JSON.stringify({
      event: "instagram_query_batch_started",
      job_id: jobId || null,
      query_name: queryName,
      batch_number: batchNumber,
      result_count: users.length,
      total_count: null,
    }),
  );

  const usernameList = users.map((user) => user.username).filter(Boolean);
  const apifyResult = await scrapeWithInstagramAPIBulk(usernameList, cookieString, {
    context: {
      jobType: relationshipType === "following" ? "following" : "followers",
      jobId,
      userId,
    },
    // Hard enforce 50-sized chunks for relationship enrichment.
    chunkSize: 50,
    maxChunkSize: 50,
    allowSingleAsFinalLeftover: processedCountBeforeBatch > 0,
    returnMeta: true,
    onChunkComplete: ({ chunkIndex, inputCount, outputCount, metricsSnapshot }) => {
      chunksProcessedInBatch += 1;
      emitScrapeRealtime({
        userId,
        event: "scrape:enrichment_chunk",
        payload: {
          job_id: jobId || null,
          type: relationshipType,
          batch_number: batchNumber,
          chunk_index: chunkIndex,
          chunk_input_count: inputCount,
          chunk_output_count: outputCount,
          chunks_processed_in_batch: chunksProcessedInBatch,
          ...metricsSnapshot,
        },
      });
    },
  });

  const profileMap = apifyResult.profileByUsername || new Map();

  for (const user of users) {
    const profile = profileMap.get(String(user.username || "").toLowerCase()) || null;
    enrichedUsers.push(mapGraphQLUserWithProfile(user, profile));
  }

  if (apifyResult.stage === "SKIPPED_COST_LIMIT") {
    console.warn(
      `[Instagram GraphQL] Skipping Apify enrichment due to cost limit (estimated=${apifyResult.estimatedCost}, budget=${apifyResult.budgetUsd})`,
    );
  }

  console.log(
    JSON.stringify({
      event: "instagram_query_batch_finished",
      job_id: jobId || null,
      query_name: queryName,
      result_count: enrichedUsers.length,
      total_count: null,
      elapsed_ms: Date.now() - startedAt,
      apify_metrics: apifyResult.metrics,
      enrichment_stage: apifyResult.stage,
    }),
  );

  return enrichedUsers;
};

const saveInstagramRelationshipBatch = async ({
  enrichedUsers,
  user_id,
  folder_id,
  targetUsername,
  type,
  jobId = null,
}) => {
  if (!enrichedUsers.length) {
    return {
      insertedLeads: [],
      cachedCount: 0,
      newCount: 0,
      linkedCount: 0,
    };
  }

  let reservedCredits = 0;
  const leadsToInsert = enrichedUsers.map((user) =>
    buildInstagramRelationshipLeadPayload({
      user,
      type,
      targetUsername,
      scrapingMethod: "GraphQL API + web_profile_info",
    }),
  );

  try {
    reservedCredits = await reserveScrapedProfileCredits(
      user_id,
      leadsToInsert.length,
    );

    const bulkResult = await userLeadService.bulkResolveOrCreate(
      leadsToInsert,
      {
        user_id,
        folder_id,
        type: "INSTAGRAM",
        scraped_from_username: targetUsername,
        relationship_type: toRelationshipDirection(type),
      },
    );

    await refundUnusedScrapedProfileCredits(
      user_id,
      reservedCredits,
      bulkResult.insertedLeads.length,
    );
    enqueueRelationshipDeepScans({
      user_id,
      job_id: jobId,
      leads: bulkResult.insertedLeads,
      label: "Instagram GraphQL",
    });
    console.log(
      `[Instagram] Done — new: ${bulkResult.newCount}, from cache: ${bulkResult.cachedCount}`,
    );
    return {
      insertedLeads: bulkResult.insertedLeads,
      cachedCount: bulkResult.cachedCount,
      newCount: bulkResult.newCount,
      linkedCount: bulkResult.userLeads?.insertedCount || 0,
    };
  } catch (error) {
    await refundUnusedScrapedProfileCredits(user_id, reservedCredits, 0);
    throw error;
  }
};

const scrapeWithSteadyAPI = async (username) => {
  console.log(`[SteadyAPI] Fallback scrape for username: ${username}`);

  try {
    const response = await axios.get(
      `https://api.steadyapi.com/v1/instagram/profile?username=${username}`,
      {
        timeout: 30000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      },
    );

    if (!response.data?.body) {
      throw new Error("Invalid response from SteadyAPI");
    }

    console.log("[SteadyAPI] Successfully scraped profile");
    return response.data.body;
  } catch (error) {
    console.log("[SteadyAPI] Error:", error.message);
    throw error;
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Transform Apify Response to Lead Format
// ═══════════════════════════════════════════════════════════════════════════
const transformApifyToLead = (apifyData) => {
  const { first_name, last_name } = splitName(apifyData.fullName);

  // Extract emails and phones from bio
  const bioEmails = extractEmails(apifyData.biography || "");
  const bioPhones = extractPhones(apifyData.biography || "");

  // Extract external URLs
  const externalUrls = uniqueValues(
    [
      apifyData.externalUrl,
      ...(Array.isArray(apifyData.externalUrls)
        ? apifyData.externalUrls.map((link) => link.url).filter(Boolean)
        : []),
    ].filter(Boolean),
  );

  // Build profile data structure
  const profileData = {
    instagram_profile_id: apifyData.id || null,
    username: apifyData.username || null,
    full_name: apifyData.fullName || null,
    bio: apifyData.biography || null,
    avatar_url: apifyData.profilePicUrlHD || apifyData.profilePicUrl || null,
    followers: parseCount(apifyData.followersCount),
    following: parseCount(apifyData.followsCount),
    total_posts: parseCount(apifyData.postsCount),
    category: apifyData.businessCategoryName || null,
    external_url: apifyData.externalUrl || null,
    external_url_linkshimmed: apifyData.externalUrlShimmed || null,
    external_urls: externalUrls,
    is_private: apifyData.private ?? null,
    is_verified: apifyData.verified ?? null,
    is_public: apifyData.private !== null ? !apifyData.private : null,
    highlight_reel_count: parseCount(apifyData.highlightReelCount),
    links: Array.isArray(apifyData.externalUrls) ? apifyData.externalUrls : [],
    source_url:
      apifyData.url || `https://www.instagram.com/${apifyData.username}`,
  };

  return {
    profileData,
    first_name,
    last_name,
    bioEmails,
    bioPhones,
    externalUrls,
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// Transform SteadyAPI Response to Lead Format
// ═══════════════════════════════════════════════════════════════════════════
const transformSteadyAPIToLead = (steadyData) => {
  const { first_name, last_name } = splitName(steadyData.full_name);

  const bioEmails = extractEmails(steadyData.biography || "");
  const bioPhones = extractPhones(steadyData.biography || "");

  const externalUrls = uniqueValues(
    [
      steadyData.external_url,
      ...(Array.isArray(steadyData.bio_links)
        ? steadyData.bio_links.map((link) => link.url).filter(Boolean)
        : []),
    ].filter(Boolean),
  );

  const profileData = {
    instagram_profile_id: steadyData.id || null,
    username: steadyData.username || null,
    full_name: steadyData.full_name || null,
    bio: steadyData.biography || null,
    avatar_url: steadyData.profile_pic_hd || steadyData.profile_pic || null,
    followers: parseCount(steadyData.followers),
    following: parseCount(steadyData.following),
    total_posts: parseCount(steadyData.posts),
    category: steadyData.category || null,
    external_url: steadyData.external_url || null,
    external_url_linkshimmed: null,
    external_urls: externalUrls,
    is_private: steadyData.is_private ?? null,
    is_verified: steadyData.is_verified ?? null,
    is_public: steadyData.is_private !== null ? !steadyData.is_private : null,
    highlight_reel_count: parseCount(steadyData.highlight_reel_count),
    links: Array.isArray(steadyData.bio_links) ? steadyData.bio_links : [],
    source_url:
      steadyData.profile_url ||
      `https://www.instagram.com/${steadyData.username}`,
  };

  return {
    profileData,
    first_name,
    last_name,
    bioEmails,
    bioPhones,
    externalUrls,
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// Main Function: Scrape Instagram Profile
// ═══════════════════════════════════════════════════════════════════════════
const scrapeInstagram = async ({ profileUrl, user_id, folder_id }) => {
  if (!profileUrl) {
    return {
      code: 400,
      success: false,
      message: "instagram-profile-url-is-required",
    };
  }

  // Extract username from URL
  let username;
  try {
    const url = new URL(profileUrl);
    username = url.pathname.split("/").filter(Boolean)[0];
    if (!username) {
      throw new Error("Invalid Instagram URL");
    }
  } catch (error) {
    return {
      code: 400,
      success: false,
      message: "invalid-instagram-url",
      error: error.message,
    };
  }

  let profileData;
  let first_name, last_name, bioEmails, bioPhones, externalUrls;
  let scrapedWith = "instagram-api";

  // Try Instagram API first
  try {
    const apifyData = await scrapeWithInstagramAPI(username);
    const transformed = transformApifyToLead(apifyData);
    profileData = transformed.profileData;
    first_name = transformed.first_name;
    last_name = transformed.last_name;
    bioEmails = transformed.bioEmails;
    bioPhones = transformed.bioPhones;
    externalUrls = transformed.externalUrls;
  } catch (apifyError) {
    console.log("[Main] Instagram API failed, trying SteadyAPI fallback");

    // Fallback to SteadyAPI
    try {
      const steadyData = await scrapeWithSteadyAPI(username);
      const transformed = transformSteadyAPIToLead(steadyData);
      profileData = transformed.profileData;
      first_name = transformed.first_name;
      last_name = transformed.last_name;
      bioEmails = transformed.bioEmails;
      bioPhones = transformed.bioPhones;
      externalUrls = transformed.externalUrls;
      scrapedWith = "steadyapi";
    } catch (steadyError) {
      console.log("[Main] Both Apify and SteadyAPI failed");
      return {
        code: 500,
        success: false,
        message: "failed-to-scrape-instagram-profile",
        errors: {
          apify: apifyError.message,
          steadyapi: steadyError.message,
        },
      };
    }
  }

  // Perform deep scan on external URLs
  let deepScanResults = [];
  let allEmails = [...bioEmails];
  let allPhones = [...bioPhones];
  let skippedCount = 0;

  if (DEEP_SCAN_INLINE_SINGLE_PROFILE && externalUrls.length > 0) {
    console.log(`[Main] Starting deep scan for ${externalUrls.length} URLs`);

    for (const url of externalUrls) {
      const scanResult = await deepScanExternalUrl(url);

      if (scanResult.skipped) {
        skippedCount++;
      }

      deepScanResults.push(scanResult);

      if (scanResult.emails.length > 0) {
        allEmails.push(...scanResult.emails);
      }
      if (scanResult.phone_numbers.length > 0) {
        allPhones.push(...scanResult.phone_numbers);
      }

      // Small delay between requests
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    console.log(
      `[Main] Deep scan completed. Scanned: ${externalUrls.length - skippedCount}, Skipped: ${skippedCount}`,
    );
  }

  // Unique values
  allEmails = uniqueValues(allEmails);
  allPhones = uniqueValues(allPhones);

  // Create or reuse Lead + link via UserLead (dedup-aware)
  try {
    const leadPayload = {
      first_name,
      last_name,
      company: profileData.username || "",
      emails: allEmails,
      phone_numbers: allPhones,
      message: `
Instagram Profile Scraped

Username: ${profileData.username || "N/A"}
Full Name: ${profileData.full_name || "N/A"}
Bio: ${profileData.bio || "N/A"}
Followers: ${profileData.followers || "N/A"}
Following: ${profileData.following || "N/A"}
Profile URL: ${profileData.source_url}
Scraped with: ${scrapedWith.toUpperCase()}
      `.trim(),
      source_url: profileData.source_url,
      source_rul: profileData.source_url,
      instagram_profile_id: profileData.instagram_profile_id,
      username: profileData.username,
      full_name: profileData.full_name,
      bio: profileData.bio,
      avatar_url: profileData.avatar_url,
      avatar_rul: profileData.avatar_url,
      followers: profileData.followers,
      following: profileData.following,
      follower_count: profileData.followers,
      following_count: profileData.following,
      total_posts: profileData.total_posts,
      category: profileData.category,
      external_url: profileData.external_url,
      external_url_linkshimmed: profileData.external_url_linkshimmed,
      external_urls: profileData.external_urls,
      is_private: profileData.is_private,
      is_verified: profileData.is_verified,
      is_public: profileData.is_public,
      fb_profile_biolink: null,
      highlight_reel_count: null,
      links: profileData.links,
      scrape_status: true,
      type: "INSTAGRAM",
    };

    const { lead, fromCache } = await userLeadService.resolveOrCreateLead(
      leadPayload,
      { user_id, folder_id, type: "INSTAGRAM" },
    );

    if (!DEEP_SCAN_INLINE_SINGLE_PROFILE && externalUrls.length > 0) {
      enqueueDeepScanBatch({
        user_id,
        lead_ids: externalUrls.map(() => lead?._id),
        urls: externalUrls,
        job_id: null,
      }).catch((error) => {
        console.warn(
          `[DeepScan] enqueue failed for @${profileData.username}: ${error.message}`,
        );
      });
    }

    return {
      code: 200,
      success: true,
      message: fromCache
        ? "instagram-profile-fetched-from-cache"
        : "instagram-profile-scraped-successfully",
      scraped_with: scrapedWith,
      from_cache: fromCache,
      data: {
        lead,
        profile: profileData,
        deep_scan: {
          scanned_urls: deepScanResults.length,
          results: deepScanResults,
          total_emails_found: allEmails.length,
          total_phones_found: allPhones.length,
        },
      },
    };
  } catch (dbError) {
    console.error("[Main] Database error:", dbError);
    return {
      code: 500,
      success: false,
      message: "failed-to-save-lead-to-database",
      error: dbError.message,
    };
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Bulk Instagram Profile Scraper
// ═══════════════════════════════════════════════════════════════════════════
const scrapeInstagramBulk = async ({ profileUrls, user_id, folder_id }) => {
  if (!profileUrls || !Array.isArray(profileUrls) || profileUrls.length === 0) {
    return {
      code: 400,
      success: false,
      message: "profileUrls array is required and cannot be empty",
    };
  }

  console.log(`[Bulk] Starting bulk scrape for ${profileUrls.length} profiles`);

  // Extract all usernames from profile URLs
  const usernames = [];
  const usernameToUrlMap = new Map();

  for (const profileUrl of profileUrls) {
    const username = profileUrl
      .replace(/https?:\/\/(www\.)?instagram\.com\//gi, "")
      .replace(/\/$/, "")
      .trim();

    if (username) {
      usernames.push(username);
      usernameToUrlMap.set(username.toLowerCase(), profileUrl);
    }
  }

  if (usernames.length === 0) {
    return {
      code: 400,
      success: false,
      message: "No valid usernames found in profileUrls",
    };
  }

  console.log(`[Bulk] Extracted ${usernames.length} valid usernames`);

  const results = [];
  const leadsToInsert = [];
  let successCount = 0;
  let failCount = 0;

  try {
    // Fetch profiles via Instagram API
    console.log(
      `[Bulk] Sending request to Instagram API for ${usernames.length} profiles...`,
    );
    const apifyBulkData = await scrapeWithInstagramAPIBulk(usernames, null, {
      context: {
        jobType: "bulk_profiles",
        userId: user_id || null,
      },
    });

    // Process each result from Apify
    for (const apifyData of apifyBulkData) {
      try {
        const transformed = transformApifyToLead(apifyData);
        const {
          profileData,
          first_name,
          last_name,
          bioEmails,
          bioPhones,
          externalUrls,
        } = transformed;

        // Unique values
        const allEmails = uniqueValues(bioEmails);
        const allPhones = uniqueValues(bioPhones);

        // Get original profile URL
        const originalUrl =
          usernameToUrlMap.get(profileData.username?.toLowerCase()) ||
          profileData.source_url;

        // Prepare lead data for bulk insert
        const leadData = {
          first_name,
          last_name,
          company: profileData.username || "",
          emails: allEmails,
          phone_numbers: allPhones,
          message: `
Instagram Profile Scraped (Bulk)

Username: ${profileData.username || "N/A"}
Full Name: ${profileData.full_name || "N/A"}
Bio: ${profileData.bio || "N/A"}
Followers: ${profileData.followers || "N/A"}
Following: ${profileData.following || "N/A"}
Profile URL: ${profileData.source_url}
Scraped with: APIFY
          `.trim(),
          source_url: profileData.source_url,
          source_rul: profileData.source_url,
          instagram_profile_id: profileData.instagram_profile_id,
          username: profileData.username,
          full_name: profileData.full_name,
          bio: profileData.bio,
          avatar_url: profileData.avatar_url,
          avatar_rul: profileData.avatar_url,
          followers: profileData.followers,
          following: profileData.following,
          follower_count: profileData.followers,
          following_count: profileData.following,
          total_posts: profileData.total_posts,
          category: profileData.category,
          external_url: profileData.external_url,
          external_url_linkshimmed: null,
          external_urls: profileData.external_urls,
          is_private: profileData.is_private,
          is_verified: profileData.is_verified,
          is_public: profileData.is_public,
          fb_profile_biolink: null,
          highlight_reel_count: null,
          links: profileData.links,
          scrape_status: true,
          type: "INSTAGRAM",
        };

        leadsToInsert.push(leadData);

        results.push({
          profileUrl: originalUrl,
          username: profileData.username,
          success: true,
          scraped_with: "apify",
          profile: profileData,
        });

        successCount++;
      } catch (transformError) {
        console.error(
          `[Bulk] Error transforming profile data:`,
          transformError.message,
        );
        results.push({
          profileUrl: apifyData.url || "unknown",
          username: apifyData.username || "unknown",
          success: false,
          error: transformError.message,
        });
        failCount++;
      }
    }

    console.log(
      `[Bulk] Processed ${successCount} profiles successfully, ${failCount} failed`,
    );
  } catch (apifyError) {
    console.error(`[Bulk] Apify bulk scrape failed:`, apifyError.message);

    // If bulk Apify fails, mark all as failed
    for (const username of usernames) {
      results.push({
        profileUrl: usernameToUrlMap.get(username.toLowerCase()),
        username: username,
        success: false,
        error: apifyError.message,
      });
      failCount++;
    }
  }

  // Bulk insert all leads into MongoDB
  let insertedLeads = [];
  if (leadsToInsert.length > 0) {
    try {
      console.log(
        `[Bulk] Inserting ${leadsToInsert.length} leads into database...`,
      );
      insertedLeads = await Lead.insertMany(leadsToInsert, { ordered: false });
      console.log(`[Bulk] Successfully inserted ${insertedLeads.length} leads`);
    } catch (dbError) {
      console.error("[Bulk] Database bulk insert error:", dbError.message);
      // Even if some fail, insertMany with ordered:false will continue
      // Check if any were inserted
      if (dbError.insertedDocs) {
        insertedLeads = dbError.insertedDocs;
      }
    }
  }

  return {
    code: 200,
    success: true,
    message: "bulk-instagram-scraping-completed",
    data: {
      total: profileUrls.length,
      success: successCount,
      failed: failCount,
      leads_inserted: insertedLeads.length,
      results: results,
      leads: insertedLeads,
    },
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// Instagram Browser Automation - Followers/Following Scraper
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════

const activeRelationshipLocks = new Map();

const buildRelationshipLockKey = ({ jobId, userId, targetUsername, type }) => {
  if (jobId) return `instagram:scrape:${jobId}`;
  return [
    "instagram:relationship",
    userId || "anonymous",
    String(targetUsername || "").trim().toLowerCase() || "unknown-target",
    normalizeRelationshipRequestType(type),
  ].join(":");
};

const acquireRelationshipLock = (context) => {
  const lockKey = buildRelationshipLockKey(context);
  if (activeRelationshipLocks.has(lockKey)) {
    return { acquired: false, lockKey };
  }

  activeRelationshipLocks.set(lockKey, {
    ...context,
    acquiredAt: Date.now(),
  });

  return { acquired: true, lockKey };
};

const releaseRelationshipLock = (lockKey) => {
  if (lockKey) activeRelationshipLocks.delete(lockKey);
};

// ═══════════════════════════════════════════════════════════════════════════
// RESOURCE LIMITS - Safe limits for EC2 micro (1GB RAM)
// ═══════════════════════════════════════════════════════════════════════════
const SAFE_SCRAPE_LIMIT = 300; // Max users to scrape per session (memory safe)
const ENRICH_LIMIT = 100; // Max users to enrich with Apify (API safe)

// Human-like delay helper
const humanDelay = (min = 1000, max = 3000) => {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, delay));
};

// Longer delay for page loads
const pageLoadDelay = () => humanDelay(2000, 4000);

// Gentle scroll delay
const scrollDelay = () => humanDelay(800, 1500);

// Type like a human
const humanType = async (page, selector, text, delayBetweenKeys = 100) => {
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

// Save cookies to file
// Save cookies to file
const saveCookies = async (page, filepath) => {
  const cookies = await page.cookies();

  // Ensure directory exists
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[Instagram] Created directory: ${dir}`);
  }

  fs.writeFileSync(filepath, JSON.stringify(cookies, null, 2));
  console.log(`[Instagram] Cookies saved to ${filepath}`);
};

// Load cookies from file
const loadCookies = async (page, filepath) => {
  if (fs.existsSync(filepath)) {
    const cookies = JSON.parse(fs.readFileSync(filepath, "utf-8"));
    await page.setCookie(...cookies);
    console.log(`[Instagram] Cookies loaded from ${filepath}`);
    return true;
  }
  return false;
};

// Check if logged in
const isLoggedIn = async (page) => {
  try {
    // Wait a bit for page to settle
    await humanDelay(1500, 2500);

    console.log("[Instagram] Running login detection checks...");

    // PRIORITY 1: Positive check - Look for elements that only appear when logged in
    const loggedInIndicator = await page.evaluate(() => {
      // Check for nav bar elements (home, search, etc.)
      const nav = document.querySelector("nav");
      if (nav) {
        // Look for home link or user menu or svg icons (indicating logged-in nav)
        const hasHomeLink = nav.querySelector('a[href="/"]');
        const hasSvg = nav.querySelector("svg");
        const hasProfileLink = nav.textContent
          .toLowerCase()
          .includes("profile");

        if ((hasHomeLink && hasSvg) || hasProfileLink) {
          console.log("[Instagram Check] Found logged-in navigation elements");
          return true;
        }
      }

      // Check for search bar or create post elements
      const hasSearchOrCreate =
        document.querySelector('input[placeholder*="Search"]') ||
        document.querySelector('[aria-label*="New post"]') ||
        document.querySelector('[aria-label*="Create"]');
      if (hasSearchOrCreate) {
        console.log("[Instagram Check] Found search/create elements");
        return true;
      }

      return false;
    });

    if (loggedInIndicator) {
      console.log(
        "[Instagram] ✓ Detected logged-in state (positive indicators)",
      );
      return true;
    }

    // PRIORITY 2: Check for login page URL
    const currentUrl = page.url();
    if (currentUrl.includes("/accounts/login")) {
      console.log("[Instagram] ✗ On login page - not logged in");
      return false;
    }

    // PRIORITY 3: Check for "Log in" dialog/modal (appears on profile pages when not logged in)
    const loginDialog = await page.evaluate(() => {
      const dialogs = document.querySelectorAll('div[role="dialog"]');
      for (const dialog of dialogs) {
        if (
          dialog.textContent.includes("Log in") ||
          dialog.textContent.includes("Sign up for Instagram")
        ) {
          console.log("[Instagram Check] Found login dialog");
          return true;
        }
      }
      return false;
    });

    if (loginDialog) {
      console.log("[Instagram] ✗ Detected login dialog - not logged in");
      return false;
    }

    // PRIORITY 4: Check for login form inputs (last resort)
    const emailInput = await page.$('input[name="email"]');
    const usernameInput = await page.$('input[name="username"]');
    const passwordInput = await page.$(
      'input[name="pass"], input[name="password"]',
    );

    if ((emailInput || usernameInput) && passwordInput) {
      console.log("[Instagram] ✗ Detected login form - not logged in");
      return false;
    }

    // If we reach here and found no negative indicators, assume logged in
    console.log("[Instagram] ✓ No login indicators found - assuming logged in");
    return true;
  } catch (error) {
    console.log("[Instagram] Error checking login status:", error.message);
    return false;
  }
};

// Dismiss Instagram prompts/dialogs (Save Login Info, Notifications, etc.)
const dismissPrompts = async (page, maxAttempts = 3) => {
  for (let i = 0; i < maxAttempts; i++) {
    await humanDelay(1000, 2000);

    const dismissed = await page.evaluate(() => {
      // Find "Not Now" buttons
      const elements = Array.from(
        document.querySelectorAll('button, div[role="button"]'),
      );
      const notNowButton = elements.find((el) => {
        const text = el.textContent.trim().toLowerCase();
        return text === "not now";
      });

      if (notNowButton) {
        const parentText = notNowButton.closest("div")?.textContent || "";
        console.log(
          `[Instagram Check] Found "Not Now" button in context: ${parentText.substring(0, 50)}...`,
        );
        notNowButton.click();
        return true;
      }

      return false;
    });

    if (dismissed) {
      console.log(`[Instagram] Dismissed prompt (attempt ${i + 1})`);
      await humanDelay(1000, 2000);
    } else {
      // No more prompts found
      console.log(`[Instagram] No more prompts to dismiss (attempt ${i + 1})`);
      break;
    }
  }
};

// Login to Instagram
const loginToInstagram = async (page) => {
  const username = process.env.INSTAGRAM_USERNAME;
  const password = process.env.INSTAGRAM_PASSWORD;
  const usernameSelector =
    process.env.INSTAGRAM_USERNAME_SELECTOR || 'input[name="username"]';
  const passwordSelector =
    process.env.INSTAGRAM_PASSWORD_SELECTOR || 'input[name="password"]';

  if (!username || !password) {
    throw new Error(
      "Instagram credentials not configured in environment variables",
    );
  }

  console.log("[Instagram] Navigating to login page...");
  await page.goto("https://www.instagram.com/accounts/login/", {
    waitUntil: "networkidle2",
    timeout: 30000,
  });

  await pageLoadDelay();

  // Give extra time for account selection screen to fully render
  await humanDelay(1500, 2500);

  // Check for account selection screen and click "Use another profile"
  console.log("[Instagram] Checking for account selection screen...");

  // Try to wait for the "Use another profile" button (up to 5 seconds)
  let useAnotherProfileClicked = false;
  try {
    await page.waitForSelector(
      '[aria-label="Use another profile"][role="button"]',
      {
        timeout: 5000,
        visible: true,
      },
    );
    console.log(
      '[Instagram] "Use another profile" button detected, clicking...',
    );

    useAnotherProfileClicked = await page.evaluate(() => {
      const useAnotherBtn = document.querySelector(
        '[aria-label="Use another profile"][role="button"]',
      );
      if (useAnotherBtn) {
        console.log('[Instagram] Clicking "Use another profile" button...');
        useAnotherBtn.click();
        return true;
      }
      return false;
    });
  } catch (error) {
    console.log(
      '[Instagram] "Use another profile" button not found within timeout, checking manually...',
    );

    // Fallback: manual search
    useAnotherProfileClicked = await page.evaluate(() => {
      const allButtons = Array.from(
        document.querySelectorAll('[role="button"]'),
      );
      console.log(
        `[Instagram] Manually checking ${allButtons.length} buttons...`,
      );

      for (const btn of allButtons) {
        const btnText = btn.textContent.trim();
        const ariaLabel = btn.getAttribute("aria-label");

        if (
          btnText.includes("Use another profile") ||
          btnText.includes("use another profile") ||
          ariaLabel?.includes("Use another profile")
        ) {
          console.log(`[Instagram] Found match, clicking...`);
          btn.click();
          return true;
        }
      }
      return false;
    });
  }

  if (useAnotherProfileClicked) {
    console.log(
      "[Instagram] Clicked 'Use another profile', waiting for login form...",
    );
    await humanDelay(2000, 3000);
  } else {
    console.log(
      "[Instagram] 'Use another profile' button not found, checking if login form is already visible...",
    );
    await humanDelay(1000, 1500);
  }

  // Check if username and password fields exist
  console.log("[Instagram] Checking for login form fields...");
  const fieldsExist = await page.evaluate(
    (usernameSelector, passwordSelector) => {
      const usernameField = document.querySelector(usernameSelector);
      const passwordField = document.querySelector(passwordSelector);
      return {
        usernameExists: !!usernameField,
        passwordExists: !!passwordField,
        usernameVisible: usernameField && usernameField.offsetParent !== null,
        passwordVisible: passwordField && passwordField.offsetParent !== null,
      };
    },
    usernameSelector,
    passwordSelector,
  );

  console.log(`[Instagram] Login fields status:`, fieldsExist);

  // If neither field exists, throw error
  if (!fieldsExist.usernameExists && !fieldsExist.passwordExists) {
    throw new Error(
      "Login form not found - no username or password fields detected",
    );
  }

  // Wait for fields to be visible if they exist but aren't visible yet
  if (
    (fieldsExist.usernameExists && !fieldsExist.usernameVisible) ||
    (fieldsExist.passwordExists && !fieldsExist.passwordVisible)
  ) {
    console.log("[Instagram] Waiting for login fields to become visible...");
    await humanDelay(1000, 2000);
  }

  // Type username only if field exists (some modals only show password for saved accounts)
  if (fieldsExist.usernameExists && fieldsExist.usernameVisible) {
    console.log("[Instagram] Typing username...");
    await humanType(page, usernameSelector, username, 120);
    await humanDelay(500, 1000);
  } else {
    console.log(
      "[Instagram] Skipping username (field not present - using saved account)",
    );
  }

  // Type password (should always be present)
  if (fieldsExist.passwordExists && fieldsExist.passwordVisible) {
    console.log("[Instagram] Typing password...");
    await humanType(page, passwordSelector, password, 100);
    await humanDelay(800, 1500);
  } else {
    throw new Error("Password field not visible or not found");
  }

  console.log("[Instagram] Clicking login button...");
  // Find and click login button by text content (more reliable than classes)
  const loginClicked = await page.evaluate(() => {
    const buttons = Array.from(
      document.querySelectorAll('button, div[role="button"]'),
    );
    const loginButton = buttons.find(
      (btn) => btn.textContent.trim().toLowerCase() === "log in",
    );
    if (loginButton) {
      loginButton.click();
      return true;
    }
    return false;
  });

  if (!loginClicked) {
    throw new Error("Login button not found");
  }

  // Wait for navigation after login
  await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 });
  await pageLoadDelay();

  // Dismiss any prompts that appear after login (Save Info, Notifications, etc.)
  console.log("[Instagram] Checking for post-login prompts...");
  await dismissPrompts(page, 3);

  console.log("[Instagram] Login successful!");
  return true;
};

// ═══════════════════════════════════════════════════════════════════════════
// GraphQL-based Instagram Scraper (Alternative Method)
// ═══════════════════════════════════════════════════════════════════════════
// List of domains to skip during deep scan (social platforms, tech giants, etc.)
const SKIP_DOMAINS = [
  "apple.com",
  "youtube.com",
  "google.com",
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "tiktok.com",
  "snapchat.com",
  "pinterest.com",
  "reddit.com",
  "amazon.com",
  "ebay.com",
  "paypal.com",
  "github.com",
  "stackoverflow.com",
  "microsoft.com",
  "zoom.us",
  "discord.com",
  "telegram.org",
  "whatsapp.com",
  "spotify.com",
  "netflix.com",
  "t.co",
  "bit.ly",
  "tinyurl.com",
];

const shouldSkipDomain = (url) => {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase().replace(/^www\\./, "");

    // Check if hostname matches or ends with any skip domain
    return SKIP_DOMAINS.some((domain) => {
      return hostname === domain || hostname.endsWith("." + domain);
    });
  } catch (error) {
    return false;
  }
};

const deepScanExternalUrl = async (externalUrl, options = {}) =>
  queuedDeepScanExternalUrl(externalUrl, options);

const enqueueRelationshipDeepScans = ({
  user_id,
  job_id,
  leads = [],
  label = "Instagram",
}) => {
  if (!DEEP_SCAN_RELATIONSHIP_ENABLED || !leads.length) {
    return;
  }

  const scanTargets = leads
    .map((lead) => ({
      lead_id: lead?._id,
      url: lead?.external_url || lead?.external_urls?.[0] || null,
    }))
    .filter((target) => target.lead_id && target.url);

  if (!scanTargets.length) {
    return;
  }

  enqueueDeepScanBatch({
    user_id,
    job_id,
    lead_ids: scanTargets.map((target) => target.lead_id),
    urls: scanTargets.map((target) => target.url),
  }).catch((error) => {
    console.warn(`[DeepScan] ${label} enqueue failed: ${error.message}`);
  });
};

/*
const scrapeWithApify = async (username) => {
  const apifyToken = process.env.APIFY_API_KEY;
  if (!apifyToken) {
    throw new Error("APIFY_API_KEY not configured in environment variables");
  }

  const client = new ApifyClient({ token: apifyToken });

  console.log(`[Apify] Starting scrape for username: ${username}`);

  const input = {
    usernames: [`https://www.instagram.com/${username}/`],
  };

  try {
    const run = await client.actor(APIFY_INSTAGRAM_PROFILE_ACTOR_ID).call(input);
    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    if (!items || items.length === 0) {
      throw new Error("No data returned from Apify");
    }

    console.log("[Apify] Successfully scraped profile");
    return items[0];
  } catch (error) {
    console.log("[Apify] Error:", error.message);
    throw error;
  }
};

const scrapeWithApifyBulk = async (usernames) => {
  const apifyToken = process.env.APIFY_API_KEY;
  if (!apifyToken) {
    throw new Error("APIFY_API_KEY not configured in environment variables");
  }

  const client = new ApifyClient({ token: apifyToken });

  console.log(
    `[Apify Bulk] Starting bulk scrape for ${usernames.length} usernames`,
  );

  const instagramUrls = usernames.map(
    (username) => `https://www.instagram.com/${username}/`,
  );

  const input = {
    usernames: instagramUrls,
  };

  try {
    const run = await client.actor(APIFY_INSTAGRAM_PROFILE_ACTOR_ID).call(input);
    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    if (!items || items.length === 0) {
      throw new Error("No data returned from Apify bulk scrape");
    }

    console.log(`[Apify Bulk] Successfully scraped ${items.length} profiles`);
    return items;
  } catch (error) {
    console.log("[Apify Bulk] Error:", error.message);
    throw error;
  }
};
*/

// Legacy HTML scraper removed. Use scrapeWithInstagramAPI/scrapeWithInstagramAPIBulk.

// ═══════════════════════════════════════════════════════════════════════════
// Instagram JSON API Scraper (i.instagram.com)
// ═══════════════════════════════════════════════════════════════════════════
const scrapeWithInstagramAPI = async (
  username,
  cookieString = null,
  forcedProxyConfig = null,
  { maxRequestRetries = INSTAGRAM_JSON_RETRIES } = {},
) => {
  const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  // const url = `https://i.instagram.com/api/v1/users/${encodeURIComponent(username)}/usernameinfo`;
  // const url = `https://instagram.com/${encodeURIComponent(username)}/?__a=1&__d=dis`;
  const headers = {
    "User-Agent": "Instagram 219.0.0.12.117 Android",
    "X-IG-App-ID": "936619743392459",
    Accept: "application/json",
  };

  if (cookieString) {
    const csrftoken = cookieString.match(/csrftoken=([^;]+)/)?.[1];
    headers["Cookie"] = cookieString;
    if (csrftoken) headers["X-CSRFToken"] = csrftoken;
  }

  console.log(`[InstagramAPI] Fetching profile for @${username} via CheerioCrawler`);

  const responseData = await fetchJsonWithCheerioCrawler({
    url,
    headers,
    label: `instagram-profile-${username}`,
    forcedProxyConfig,
    maxRequestRetries,
    timeoutSecs: 30,
  });

  const user = responseData?.user ?? responseData?.data?.user ?? null;
  console.log(`[InstagramAPI] Received data for @${username}: ${user ? JSON.stringify(user) : "no user data"}`);
  if (!user)
    throw new Error(
      `No user data returned from Instagram API for @${username}`,
    );

  const bio = user.biography || "";
  const bioEmails = extractEmails(bio);
  const bioPhones = extractPhones(bio);

  if (user.business_email) bioEmails.push(user.business_email);
  if (user.business_phone_number) bioPhones.push(user.business_phone_number);

  // Collect external URLs
  const extUrls = (user.bio_links || []).map((l) => l.url).filter(Boolean);
  if (user.external_url && !extUrls.includes(user.external_url))
    extUrls.unshift(user.external_url);

  // Deep-scan external URLs for additional contacts
  let urlEmails = [];
  let urlPhones = [];
  if (DEEP_SCAN_INLINE_SINGLE_PROFILE && extUrls.length > 0) {
    console.log(
      `[InstagramAPI] @${username}: deep-scanning ${extUrls.length} external URL(s)...`,
    );
    for (const extUrl of extUrls) {
      try {
        const scan = await deepScanExternalUrl(extUrl);
        urlEmails.push(...(scan.emails ?? []));
        urlPhones.push(...(scan.phone_numbers ?? []));
      } catch (scanErr) {
        console.log(
          `[InstagramAPI] Deep-scan failed for ${extUrl}: ${scanErr.message}`,
        );
      }
    }
  }

  const allEmails = uniqueValues([...bioEmails, ...urlEmails]);
  const allPhones = uniqueValues([...bioPhones, ...urlPhones]);

  console.log(
    `[InstagramAPI] @${username} → ${allEmails.length} email(s), ${allPhones.length} phone(s)`,
  );

  return {
    id: user.id ?? null,
    username: user.username ?? username,
    fullName: user.full_name ?? null,
    biography: bio,
    followersCount: user.edge_followed_by?.count ?? null,
    followsCount: user.edge_follow?.count ?? null,
    postsCount: user.edge_owner_to_timeline_media?.count ?? null,
    profilePicUrl: user.profile_pic_url ?? null,
    profilePicUrlHD: user.profile_pic_url_hd ?? null,
    externalUrl: user.external_url ?? null,
    externalUrlShimmed: user.external_url_linkshimmed ?? null,
    externalUrls: extUrls.map((u) => ({ url: u })),
    verified: user.is_verified ?? false,
    private: user.is_private ?? false,
    businessCategoryName: user.business_category_name ?? null,
    emails: allEmails,
    phone_numbers: allPhones,
  };
};

// Bulk version of scrapeWithInstagramAPI
const scrapeWithInstagramAPIBulk = async (
  usernames,
  cookieString = null,
  options = {},
) => {
  const context = {
    jobType: normalizeJobType(options?.context?.jobType || "bulk_profiles"),
    jobId: options?.context?.jobId || null,
    userId: options?.context?.userId || null,
  };

  const enrichment = await enrichProfiles(usernames, {
    context,
    chunkSize: options.chunkSize || 50,
    maxChunkSize: options.maxChunkSize || 50,
    cachedUsernames: options.cachedUsernames,
    budgetUsd: options.budgetUsd,
    allowSingleAsFinalLeftover: Boolean(options.allowSingleAsFinalLeftover),
    onChunkComplete: options.onChunkComplete,
  });

  if (options.returnMeta) {
    return enrichment;
  }

  if (enrichment.stage === "SKIPPED_COST_LIMIT") {
    console.warn(
      `[InstagramAPI Bulk] Skipped due to cost limit (estimated=${enrichment.estimatedCost}, budget=${enrichment.budgetUsd})`,
    );
    return [];
  }

  return enrichment.profiles || [];
};

// ═══════════════════════════════════════════════════════════════════════════
// SteadyAPI Fallback
// ═══════════════════════════════════════════════════════════════════════════
const emitScrapeRealtime = ({
  userId,
  event,
  payload = {},
  label = "Instagram GraphQL",
}) => {
  if (!userId || !event) return;

  try {
    const io = getIO();
    io.to(`user:${userId}`).emit(event, {
      event,
      user_id: userId,
      ...payload,
      ts: Date.now(),
    });
  } catch (wsErr) {
    console.warn(`[${label}] WebSocket emit failed (non-fatal): ${wsErr.message}`);
  }
};

const parseRetryAfterMs = (retryAfterHeader) => {
  if (!retryAfterHeader) return null;

  const seconds = Number(retryAfterHeader);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(retryAfterHeader);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return null;
};

const getProfileDetailRateLimitDelayMs = (error, attempt) => {
  const retryAfterMs = parseRetryAfterMs(
    error?.response?.headers?.["retry-after"],
  );
  const exponentialMs =
    PROFILE_DETAIL_RATE_LIMIT_BACKOFF_BASE_MS *
    2 ** Math.max(0, attempt - 1);
  const cappedMs = Math.min(
    PROFILE_DETAIL_RATE_LIMIT_BACKOFF_MAX_MS,
    Math.max(retryAfterMs || 0, exponentialMs),
  );
  const jitterMs = Math.floor(Math.random() * 10_000);

  return cappedMs + jitterMs;
};

const delayAfterProfileDetailRequest = async () => {
  if (PROFILE_DETAIL_BATCH_DELAY_MAX_MS <= 0) return;
  await humanDelay(
    PROFILE_DETAIL_BATCH_DELAY_MIN_MS,
    PROFILE_DETAIL_BATCH_DELAY_MAX_MS,
  );
};

const mapGraphQLUserWithProfile = (user, profile = null, error = null) => ({
  id: profile?.id || user.id,
  username: profile?.username || user.username,
  followers: profile?.followersCount ?? null,
  following: profile?.followsCount ?? null,
  bio: profile?.biography || null,
  category: profile?.businessCategoryName || null,
  avatar: profile?.profilePicUrlHD || profile?.profilePicUrl || user.profile_pic_url,
  full_name: profile?.fullName || user.full_name || null,
  is_verified: profile?.verified ?? user.is_verified ?? false,
  is_private: profile?.private ?? user.is_private ?? false,
  external_url: profile?.externalUrl || null,
  posts_count: profile?.postsCount ?? null,
  emails: uniqueValues(profile?.emails || []),
  phone_numbers: uniqueValues(profile?.phone_numbers || []),
  ...(error ? { error: error.message } : {}),
});

const buildInstagramRelationshipLeadPayload = ({
  user,
  type,
  targetUsername,
  scrapingMethod = "GraphQL API",
}) => {
  const { first_name, last_name } = splitName(user.full_name || "");

  return {
    first_name,
    last_name,
    company: user.username || "",
    emails: user.emails || [],
    phone_numbers: user.phone_numbers || [],
    message: `
${relationshipScrapeTitle(type)} (${scrapingMethod})

Target Profile: @${targetUsername}
Username: @${user.username || "N/A"}
Full Name: ${user.full_name || "N/A"}
Bio: ${user.bio || "N/A"}
Followers: ${user.followers || "N/A"}
Following: ${user.following || "N/A"}
Posts: ${user.posts_count || "N/A"}
Verified: ${user.is_verified ? "Yes" : "No"}
Private: ${user.is_private ? "Yes" : "No"}
Category: ${user.category || "N/A"}
Profile URL: https://www.instagram.com/${user.username}
Scraping Method: ${scrapingMethod}
${user.emails && user.emails.length > 0 ? `Emails: ${user.emails.join(", ")}` : ""}
${user.phone_numbers && user.phone_numbers.length > 0 ? `Phone Numbers: ${user.phone_numbers.join(", ")}` : ""}
    `.trim(),
    scraped_from_username: targetUsername,
    relationship_type: toRelationshipDirection(type),
    source_url: `https://www.instagram.com/${user.username}`,
    source_rul: `https://www.instagram.com/${user.username}`,
    instagram_profile_id: user.id !== user.username ? user.id : null,
    username: user.username,
    full_name: user.full_name,
    bio: user.bio,
    avatar_url: user.avatar,
    avatar_rul: user.avatar,
    followers: user.followers,
    following: user.following,
    follower_count: user.followers,
    following_count: user.following,
    total_posts: user.posts_count,
    category: user.category,
    external_url: user.external_url,
    external_url_linkshimmed: null,
    external_urls: user.external_url ? [user.external_url] : [],
    is_private: user.is_private,
    is_verified: user.is_verified,
    is_public: user.is_private !== null ? !user.is_private : null,
    fb_profile_biolink: null,
    highlight_reel_count: null,
    links: [],
    scrape_status: true,
    type: "INSTAGRAM",
  };
};

const fetchProfileDetailWithAdaptiveBackoff = async ({
  user,
  cookieString,
  sessionProxyConfig,
  batchNumber,
}) => {
  for (let attempt = 1; attempt <= PROFILE_DETAIL_RATE_LIMIT_MAX_ATTEMPTS; attempt++) {
    try {
      const profile = await scrapeWithInstagramAPI(
        user.username,
        cookieString,
        sessionProxyConfig,
        { maxRequestRetries: 0 },
      );
      return mapGraphQLUserWithProfile(user, profile);
    } catch (error) {
      if (isRateLimitError(error)) {
        if (attempt >= PROFILE_DETAIL_RATE_LIMIT_MAX_ATTEMPTS) {
          console.warn(
            `[Instagram GraphQL] Batch #${batchNumber}: web_profile_info still rate-limited for @${user.username} after ${attempt} attempt(s)`,
          );
          throw error;
        }

        const waitMs = getProfileDetailRateLimitDelayMs(error, attempt);
        console.warn(
          `[Instagram GraphQL] Batch #${batchNumber}: 429 while fetching @${user.username}; waiting ${Math.round(waitMs / 1000)}s before retry ${attempt + 1}/${PROFILE_DETAIL_RATE_LIMIT_MAX_ATTEMPTS}`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      if (isAuthError(error)) {
        throw error;
      }

      console.warn(
        `[Instagram GraphQL] web_profile_info failed for @${user.username}; using GraphQL fallback: ${error.message}`,
      );
      return mapGraphQLUserWithProfile(user, null, error);
    }
  }

  return mapGraphQLUserWithProfile(user, null);
};

const enrichGraphQLBatchWithInstagramAPI = async ({
  users,
  cookieString,
  sessionProxyConfig,
  batchNumber,
  relationshipType,
  jobId,
  userId,
  processedCountBeforeBatch = 0,
}) => {
  const enrichedUsers = [];
  const startedAt = Date.now();
  let chunksProcessedInBatch = 0;

  const queryName =
    relationshipType === "following"
      ? "edge_follow"
      : "edge_followed_by";

  console.log(
    JSON.stringify({
      event: "instagram_query_batch_started",
      job_id: jobId || null,
      query_name: queryName,
      batch_number: batchNumber,
      result_count: users.length,
      total_count: null,
    }),
  );

  const usernameList = users.map((user) => user.username).filter(Boolean);
  const apifyResult = await scrapeWithInstagramAPIBulk(usernameList, cookieString, {
    context: {
      jobType: relationshipType === "following" ? "following" : "followers",
      jobId,
      userId,
    },
    // Hard enforce 50-sized chunks for relationship enrichment.
    chunkSize: 50,
    maxChunkSize: 50,
    allowSingleAsFinalLeftover: processedCountBeforeBatch > 0,
    returnMeta: true,
    onChunkComplete: ({ chunkIndex, inputCount, outputCount, metricsSnapshot }) => {
      chunksProcessedInBatch += 1;
      emitScrapeRealtime({
        userId,
        event: "scrape:enrichment_chunk",
        payload: {
          job_id: jobId || null,
          type: relationshipType,
          batch_number: batchNumber,
          chunk_index: chunkIndex,
          chunk_input_count: inputCount,
          chunk_output_count: outputCount,
          chunks_processed_in_batch: chunksProcessedInBatch,
          ...metricsSnapshot,
        },
      });
    },
  });

  const profileMap = apifyResult.profileByUsername || new Map();

  for (const user of users) {
    const profile = profileMap.get(String(user.username || "").toLowerCase()) || null;
    enrichedUsers.push(mapGraphQLUserWithProfile(user, profile));
  }

  if (apifyResult.stage === "SKIPPED_COST_LIMIT") {
    console.warn(
      `[Instagram GraphQL] Skipping Apify enrichment due to cost limit (estimated=${apifyResult.estimatedCost}, budget=${apifyResult.budgetUsd})`,
    );
  }

  console.log(
    JSON.stringify({
      event: "instagram_query_batch_finished",
      job_id: jobId || null,
      query_name: queryName,
      result_count: enrichedUsers.length,
      total_count: null,
      elapsed_ms: Date.now() - startedAt,
      apify_metrics: apifyResult.metrics,
      enrichment_stage: apifyResult.stage,
    }),
  );

  return enrichedUsers;
};

const saveInstagramRelationshipBatch = async ({
  enrichedUsers,
  user_id,
  folder_id,
  targetUsername,
  type,
  jobId = null,
}) => {
  if (!enrichedUsers.length) {
    return {
      insertedLeads: [],
      cachedCount: 0,
      newCount: 0,
      linkedCount: 0,
    };
  }

  let reservedCredits = 0;
  const leadsToInsert = enrichedUsers.map((user) =>
    buildInstagramRelationshipLeadPayload({
      user,
      type,
      targetUsername,
      scrapingMethod: "GraphQL API + web_profile_info",
    }),
  );

  try {
    reservedCredits = await reserveScrapedProfileCredits(
      user_id,
      leadsToInsert.length,
    );

    const bulkResult = await userLeadService.bulkResolveOrCreate(
      leadsToInsert,
      {
        user_id,
        folder_id,
        type: "INSTAGRAM",
        scraped_from_username: targetUsername,
        relationship_type: toRelationshipDirection(type),
      },
    );

    await refundUnusedScrapedProfileCredits(
      user_id,
      reservedCredits,
      bulkResult.insertedLeads.length,
    );
    enqueueRelationshipDeepScans({
      user_id,
      job_id: jobId,
      leads: bulkResult.insertedLeads,
      label: "Instagram GraphQL",
    });
    console.log(
      `[Instagram] Done — new: ${bulkResult.newCount}, from cache: ${bulkResult.cachedCount}`,
    );
    return {
      insertedLeads: bulkResult.insertedLeads,
      cachedCount: bulkResult.cachedCount,
      newCount: bulkResult.newCount,
      linkedCount: bulkResult.userLeads?.insertedCount || 0,
    };
  } catch (error) {
    await refundUnusedScrapedProfileCredits(user_id, reservedCredits, 0);
    throw error;
  }
};

const scrapeWithSteadyAPI = async (username) => {
  console.log(`[SteadyAPI] Fallback scrape for username: ${username}`);

  try {
    const response = await axios.get(
      `https://api.steadyapi.com/v1/instagram/profile?username=${username}`,
      {
        timeout: 30000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      },
    );

    if (!response.data?.body) {
      throw new Error("Invalid response from SteadyAPI");
    }

    console.log("[SteadyAPI] Successfully scraped profile");
    return response.data.body;
  } catch (error) {
    console.log("[SteadyAPI] Error:", error.message);
    throw error;
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Transform Apify Response to Lead Format
// ═══════════════════════════════════════════════════════════════════════════
const transformApifyToLead = (apifyData) => {
  const { first_name, last_name } = splitName(apifyData.fullName);

  // Extract emails and phones from bio
  const bioEmails = extractEmails(apifyData.biography || "");
  const bioPhones = extractPhones(apifyData.biography || "");

  // Extract external URLs
  const externalUrls = uniqueValues(
    [
      apifyData.externalUrl,
      ...(Array.isArray(apifyData.externalUrls)
        ? apifyData.externalUrls.map((link) => link.url).filter(Boolean)
        : []),
    ].filter(Boolean),
  );

  // Build profile data structure
  const profileData = {
    instagram_profile_id: apifyData.id || null,
    username: apifyData.username || null,
    full_name: apifyData.fullName || null,
    bio: apifyData.biography || null,
    avatar_url: apifyData.profilePicUrlHD || apifyData.profilePicUrl || null,
    followers: parseCount(apifyData.followersCount),
    following: parseCount(apifyData.followsCount),
    total_posts: parseCount(apifyData.postsCount),
    category: apifyData.businessCategoryName || null,
    external_url: apifyData.externalUrl || null,
    external_url_linkshimmed: apifyData.externalUrlShimmed || null,
    external_urls: externalUrls,
    is_private: apifyData.private ?? null,
    is_verified: apifyData.verified ?? null,
    is_public: apifyData.private !== null ? !apifyData.private : null,
    highlight_reel_count: parseCount(apifyData.highlightReelCount),
    links: Array.isArray(apifyData.externalUrls) ? apifyData.externalUrls : [],
    source_url:
      apifyData.url || `https://www.instagram.com/${apifyData.username}`,
  };

  return {
    profileData,
    first_name,
    last_name,
    bioEmails,
    bioPhones,
    externalUrls,
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// Transform SteadyAPI Response to Lead Format
// ═══════════════════════════════════════════════════════════════════════════
const transformSteadyAPIToLead = (steadyData) => {
  const { first_name, last_name } = splitName(steadyData.full_name);

  const bioEmails = extractEmails(steadyData.biography || "");
  const bioPhones = extractPhones(steadyData.biography || "");

  const externalUrls = uniqueValues(
    [
      steadyData.external_url,
      ...(Array.isArray(steadyData.bio_links)
        ? steadyData.bio_links.map((link) => link.url).filter(Boolean)
        : []),
    ].filter(Boolean),
  );

  const profileData = {
    instagram_profile_id: steadyData.id || null,
    username: steadyData.username || null,
    full_name: steadyData.full_name || null,
    bio: steadyData.biography || null,
    avatar_url: steadyData.profile_pic_hd || steadyData.profile_pic || null,
    followers: parseCount(steadyData.followers),
    following: parseCount(steadyData.following),
    total_posts: parseCount(steadyData.posts),
    category: steadyData.category || null,
    external_url: steadyData.external_url || null,
    external_url_linkshimmed: null,
    external_urls: externalUrls,
    is_private: steadyData.is_private ?? null,
    is_verified: steadyData.is_verified ?? null,
    is_public: steadyData.is_private !== null ? !steadyData.is_private : null,
    highlight_reel_count: parseCount(steadyData.highlight_reel_count),
    links: Array.isArray(steadyData.bio_links) ? steadyData.bio_links : [],
    source_url:
      steadyData.profile_url ||
      `https://www.instagram.com/${steadyData.username}`,
  };

  return {
    profileData,
    first_name,
    last_name,
    bioEmails,
    bioPhones,
    externalUrls,
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// Main Function: Scrape Instagram Profile
// ═══════════════════════════════════════════════════════════════════════════
const scrapeInstagram = async ({ profileUrl, user_id, folder_id }) => {
  if (!profileUrl) {
    return {
      code: 400,
      success: false,
      message: "instagram-profile-url-is-required",
    };
  }

  // Extract username from URL
  let username;
  try {
    const url = new URL(profileUrl);
    username = url.pathname.split("/").filter(Boolean)[0];
    if (!username) {
      throw new Error("Invalid Instagram URL");
    }
  } catch (error) {
    return {
      code: 400,
      success: false,
      message: "invalid-instagram-url",
      error: error.message,
    };
  }

  let profileData;
  let first_name, last_name, bioEmails, bioPhones, externalUrls;
  let scrapedWith = "instagram-api";

  // Try Instagram API first
  try {
    const apifyData = await scrapeWithInstagramAPI(username);
    const transformed = transformApifyToLead(apifyData);
    profileData = transformed.profileData;
    first_name = transformed.first_name;
    last_name = transformed.last_name;
    bioEmails = transformed.bioEmails;
    bioPhones = transformed.bioPhones;
    externalUrls = transformed.externalUrls;
  } catch (apifyError) {
    console.log("[Main] Instagram API failed, trying SteadyAPI fallback");

    // Fallback to SteadyAPI
    try {
      const steadyData = await scrapeWithSteadyAPI(username);
      const transformed = transformSteadyAPIToLead(steadyData);
      profileData = transformed.profileData;
      first_name = transformed.first_name;
      last_name = transformed.last_name;
      bioEmails = transformed.bioEmails;
      bioPhones = transformed.bioPhones;
      externalUrls = transformed.externalUrls;
      scrapedWith = "steadyapi";
    } catch (steadyError) {
      console.log("[Main] Both Apify and SteadyAPI failed");
      return {
        code: 500,
        success: false,
        message: "failed-to-scrape-instagram-profile",
        errors: {
          apify: apifyError.message,
          steadyapi: steadyError.message,
        },
      };
    }
  }

  // Perform deep scan on external URLs
  let deepScanResults = [];
  let allEmails = [...bioEmails];
  let allPhones = [...bioPhones];
  let skippedCount = 0;

  if (DEEP_SCAN_INLINE_SINGLE_PROFILE && externalUrls.length > 0) {
    console.log(`[Main] Starting deep scan for ${externalUrls.length} URLs`);

    for (const url of externalUrls) {
      const scanResult = await deepScanExternalUrl(url);

      if (scanResult.skipped) {
        skippedCount++;
      }

      deepScanResults.push(scanResult);

      if (scanResult.emails.length > 0) {
        allEmails.push(...scanResult.emails);
      }
      if (scanResult.phone_numbers.length > 0) {
        allPhones.push(...scanResult.phone_numbers);
      }

      // Small delay between requests
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    console.log(
      `[Main] Deep scan completed. Scanned: ${externalUrls.length - skippedCount}, Skipped: ${skippedCount}`,
    );
  }

  // Unique values
  allEmails = uniqueValues(allEmails);
  allPhones = uniqueValues(allPhones);

  // Create or reuse Lead + link via UserLead (dedup-aware)
  try {
    const leadPayload = {
      first_name,
      last_name,
      company: profileData.username || "",
      emails: allEmails,
      phone_numbers: allPhones,
      message: `
Instagram Profile Scraped

Username: ${profileData.username || "N/A"}
Full Name: ${profileData.full_name || "N/A"}
Bio: ${profileData.bio || "N/A"}
Followers: ${profileData.followers || "N/A"}
Following: ${profileData.following || "N/A"}
Profile URL: ${profileData.source_url}
Scraped with: ${scrapedWith.toUpperCase()}
      `.trim(),
      source_url: profileData.source_url,
      source_rul: profileData.source_url,
      instagram_profile_id: profileData.instagram_profile_id,
      username: profileData.username,
      full_name: profileData.full_name,
      bio: profileData.bio,
      avatar_url: profileData.avatar_url,
      avatar_rul: profileData.avatar_url,
      followers: profileData.followers,
      following: profileData.following,
      follower_count: profileData.followers,
      following_count: profileData.following,
      total_posts: profileData.total_posts,
      category: profileData.category,
      external_url: profileData.external_url,
      external_url_linkshimmed: profileData.external_url_linkshimmed,
      external_urls: profileData.external_urls,
      is_private: profileData.is_private,
      is_verified: profileData.is_verified,
      is_public: profileData.is_public,
      fb_profile_biolink: null,
      highlight_reel_count: null,
      links: profileData.links,
      scrape_status: true,
      type: "INSTAGRAM",
    };

    const { lead, fromCache } = await userLeadService.resolveOrCreateLead(
      leadPayload,
      { user_id, folder_id, type: "INSTAGRAM" },
    );

    if (!DEEP_SCAN_INLINE_SINGLE_PROFILE && externalUrls.length > 0) {
      enqueueDeepScanBatch({
        user_id,
        lead_ids: externalUrls.map(() => lead?._id),
        urls: externalUrls,
        job_id: null,
      }).catch((error) => {
        console.warn(
          `[DeepScan] enqueue failed for @${profileData.username}: ${error.message}`,
        );
      });
    }

    return {
      code: 200,
      success: true,
      message: fromCache
        ? "instagram-profile-fetched-from-cache"
        : "instagram-profile-scraped-successfully",
      scraped_with: scrapedWith,
      from_cache: fromCache,
      data: {
        lead,
        profile: profileData,
        deep_scan: {
          scanned_urls: deepScanResults.length,
          results: deepScanResults,
          total_emails_found: allEmails.length,
          total_phones_found: allPhones.length,
        },
      },
    };
  } catch (dbError) {
    console.error("[Main] Database error:", dbError);
    return {
      code: 500,
      success: false,
      message: "failed-to-save-lead-to-database",
      error: dbError.message,
    };
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Bulk Instagram Profile Scraper
// ═══════════════════════════════════════════════════════════════════════════
const scrapeInstagramBulk = async ({ profileUrls, user_id, folder_id }) => {
  if (!profileUrls || !Array.isArray(profileUrls) || profileUrls.length === 0) {
    return {
      code: 400,
      success: false,
      message: "profileUrls array is required and cannot be empty",
    };
  }

  console.log(`[Bulk] Starting bulk scrape for ${profileUrls.length} profiles`);

  // Extract all usernames from profile URLs
  const usernames = [];
  const usernameToUrlMap = new Map();

  for (const profileUrl of profileUrls) {
    const username = profileUrl
      .replace(/https?:\/\/(www\.)?instagram\.com\//gi, "")
      .replace(/\/$/, "")
      .trim();

    if (username) {
      usernames.push(username);
      usernameToUrlMap.set(username.toLowerCase(), profileUrl);
    }
  }

  if (usernames.length === 0) {
    return {
      code: 400,
      success: false,
      message: "No valid usernames found in profileUrls",
    };
  }

  console.log(`[Bulk] Extracted ${usernames.length} valid usernames`);

  const results = [];
  const leadsToInsert = [];
  let successCount = 0;
  let failCount = 0;

  try {
    // Fetch profiles via Instagram API
    console.log(
      `[Bulk] Sending request to Instagram API for ${usernames.length} profiles...`,
    );
    const apifyBulkData = await scrapeWithInstagramAPIBulk(usernames, null, {
      context: {
        jobType: "bulk_profiles",
        userId: user_id || null,
      },
    });

    // Process each result from Apify
    for (const apifyData of apifyBulkData) {
      try {
        const transformed = transformApifyToLead(apifyData);
        const {
          profileData,
          first_name,
          last_name,
          bioEmails,
          bioPhones,
          externalUrls,
        } = transformed;

        // Unique values
        const allEmails = uniqueValues(bioEmails);
        const allPhones = uniqueValues(bioPhones);

        // Get original profile URL
        const originalUrl =
          usernameToUrlMap.get(profileData.username?.toLowerCase()) ||
          profileData.source_url;

        // Prepare lead data for bulk insert
        const leadData = {
          first_name,
          last_name,
          company: profileData.username || "",
          emails: allEmails,
          phone_numbers: allPhones,
          message: `
Instagram Profile Scraped (Bulk)

Username: ${profileData.username || "N/A"}
Full Name: ${profileData.full_name || "N/A"}
Bio: ${profileData.bio || "N/A"}
Followers: ${profileData.followers || "N/A"}
Following: ${profileData.following || "N/A"}
Profile URL: ${profileData.source_url}
Scraped with: APIFY
          `.trim(),
          source_url: profileData.source_url,
          source_rul: profileData.source_url,
          instagram_profile_id: profileData.instagram_profile_id,
          username: profileData.username,
          full_name: profileData.full_name,
          bio: profileData.bio,
          avatar_url: profileData.avatar_url,
          avatar_rul: profileData.avatar_url,
          followers: profileData.followers,
          following: profileData.following,
          follower_count: profileData.followers,
          following_count: profileData.following,
          total_posts: profileData.total_posts,
          category: profileData.category,
          external_url: profileData.external_url,
          external_url_linkshimmed: null,
          external_urls: profileData.external_urls,
          is_private: profileData.is_private,
          is_verified: profileData.is_verified,
          is_public: profileData.is_public,
          fb_profile_biolink: null,
          highlight_reel_count: null,
          links: profileData.links,
          scrape_status: true,
          type: "INSTAGRAM",
        };

        leadsToInsert.push(leadData);

        results.push({
          profileUrl: originalUrl,
          username: profileData.username,
          success: true,
          scraped_with: "apify",
          profile: profileData,
        });

        successCount++;
      } catch (transformError) {
        console.error(
          `[Bulk] Error transforming profile data:`,
          transformError.message,
        );
        results.push({
          profileUrl: apifyData.url || "unknown",
          username: apifyData.username || "unknown",
          success: false,
          error: transformError.message,
        });
        failCount++;
      }
    }

    console.log(
      `[Bulk] Processed ${successCount} profiles successfully, ${failCount} failed`,
    );
  } catch (apifyError) {
    console.error(`[Bulk] Apify bulk scrape failed:`, apifyError.message);

    // If bulk Apify fails, mark all as failed
    for (const username of usernames) {
      results.push({
        profileUrl: usernameToUrlMap.get(username.toLowerCase()),
        username: username,
        success: false,
        error: apifyError.message,
      });
      failCount++;
    }
  }

  // Bulk insert all leads into MongoDB
  let insertedLeads = [];
  if (leadsToInsert.length > 0) {
    try {
      console.log(
        `[Bulk] Inserting ${leadsToInsert.length} leads into database...`,
      );
      insertedLeads = await Lead.insertMany(leadsToInsert, { ordered: false });
      console.log(`[Bulk] Successfully inserted ${insertedLeads.length} leads`);
    } catch (dbError) {
      console.error("[Bulk] Database bulk insert error:", dbError.message);
      // Even if some fail, insertMany with ordered:false will continue
      // Check if any were inserted
      if (dbError.insertedDocs) {
        insertedLeads = dbError.insertedDocs;
      }
    }
  }

  return {
    code: 200,
    success: true,
    message: "bulk-instagram-scraping-completed",
    data: {
      total: profileUrls.length,
      success: successCount,
      failed: failCount,
      leads_inserted: insertedLeads.length,
      results: results,
      leads: insertedLeads,
    },
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// Instagram Browser Automation - Followers/Following Scraper
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════

const activeRelationshipLocks = new Map();

const buildRelationshipLockKey = ({ jobId, userId, targetUsername, type }) => {
  if (jobId) return `instagram:scrape:${jobId}`;
  return [
    "instagram:relationship",
    userId || "anonymous",
    String(targetUsername || "").trim().toLowerCase() || "unknown-target",
    normalizeRelationshipRequestType(type),
  ].join(":");
};

const acquireRelationshipLock = (context) => {
  const lockKey = buildRelationshipLockKey(context);
  if (activeRelationshipLocks.has(lockKey)) {
    return { acquired: false, lockKey };
  }

  activeRelationshipLocks.set(lockKey, {
    ...context,
    acquiredAt: Date.now(),
  });

  return { acquired: true, lockKey };
};

const releaseRelationshipLock = (lockKey) => {
  if (lockKey) activeRelationshipLocks.delete(lockKey);
};

// ═══════════════════════════════════════════════════════════════════════════
// RESOURCE LIMITS - Safe limits for EC2 micro (1GB RAM)
// ═══════════════════════════════════════════════════════════════════════════
const SAFE_SCRAPE_LIMIT = 300; // Max users to scrape per session (memory safe)
const ENRICH_LIMIT = 100; // Max users to enrich with Apify (API safe)

// Human-like delay helper
const humanDelay = (min = 1000, max = 3000) => {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, delay));
};

// Longer delay for page loads
const pageLoadDelay = () => humanDelay(2000, 4000);

// Gentle scroll delay
const scrollDelay = () => humanDelay(800, 1500);

// Type like a human
const humanType = async (page, selector, text, delayBetweenKeys = 100) => {
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

// Save cookies to file
// Save cookies to file
const saveCookies = async (page, filepath) => {
  const cookies = await page.cookies();

  // Ensure directory exists
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[Instagram] Created directory: ${dir}`);
  }

  fs.writeFileSync(filepath, JSON.stringify(cookies, null, 2));
  console.log(`[Instagram] Cookies saved to ${filepath}`);
};

// Load cookies from file
const loadCookies = async (page, filepath) => {
  if (fs.existsSync(filepath)) {
    const cookies = JSON.parse(fs.readFileSync(filepath, "utf-8"));
    await page.setCookie(...cookies);
    console.log(`[Instagram] Cookies loaded from ${filepath}`);
    return true;
  }
  return false;
};

// Check if logged in
const isLoggedIn = async (page) => {
  try {
    // Wait a bit for page to settle
    await humanDelay(1500, 2500);

    console.log("[Instagram] Running login detection checks...");

    // PRIORITY 1: Positive check - Look for elements that only appear when logged in
    const loggedInIndicator = await page.evaluate(() => {
      // Check for nav bar elements (home, search, etc.)
      const nav = document.querySelector("nav");
      if (nav) {
        // Look for home link or user menu or svg icons (indicating logged-in nav)
        const hasHomeLink = nav.querySelector('a[href="/"]');
        const hasSvg = nav.querySelector("svg");
        const hasProfileLink = nav.textContent
          .toLowerCase()
          .includes("profile");

        if ((hasHomeLink && hasSvg) || hasProfileLink) {
          console.log("[Instagram Check] Found logged-in navigation elements");
          return true;
        }
      }

      // Check for search bar or create post elements
      const hasSearchOrCreate =
        document.querySelector('input[placeholder*="Search"]') ||
        document.querySelector('[aria-label*="New post"]') ||
        document.querySelector('[aria-label*="Create"]');
      if (hasSearchOrCreate) {
        console.log("[Instagram Check] Found search/create elements");
        return true;
      }

      return false;
    });

    if (loggedInIndicator) {
      console.log(
        "[Instagram] ✓ Detected logged-in state (positive indicators)",
      );
      return true;
    }

    // PRIORITY 2: Check for login page URL
    const currentUrl = page.url();
    if (currentUrl.includes("/accounts/login")) {
      console.log("[Instagram] ✗ On login page - not logged in");
      return false;
    }

    // PRIORITY 3: Check for "Log in" dialog/modal (appears on profile pages when not logged in)
    const loginDialog = await page.evaluate(() => {
      const dialogs = document.querySelectorAll('div[role="dialog"]');
      for (const dialog of dialogs) {
        if (
          dialog.textContent.includes("Log in") ||
          dialog.textContent.includes("Sign up for Instagram")
        ) {
          console.log("[Instagram Check] Found login dialog");
          return true;
        }
      }
      return false;
    });

    if (loginDialog) {
      console.log("[Instagram] ✗ Detected login dialog - not logged in");
      return false;
    }

    // PRIORITY 4: Check for login form inputs (last resort)
    const emailInput = await page.$('input[name="email"]');
    const usernameInput = await page.$('input[name="username"]');
    const passwordInput = await page.$(
      'input[name="pass"], input[name="password"]',
    );

    if ((emailInput || usernameInput) && passwordInput) {
      console.log("[Instagram] ✗ Detected login form - not logged in");
      return false;
    }

    // If we reach here and found no negative indicators, assume logged in
    console.log("[Instagram] ✓ No login indicators found - assuming logged in");
    return true;
  } catch (error) {
    console.log("[Instagram] Error checking login status:", error.message);
    return false;
  }
};

// Dismiss Instagram prompts/dialogs (Save Login Info, Notifications, etc.)
const dismissPrompts = async (page, maxAttempts = 3) => {
  for (let i = 0; i < maxAttempts; i++) {
    await humanDelay(1000, 2000);

    const dismissed = await page.evaluate(() => {
      // Find "Not Now" buttons
      const elements = Array.from(
        document.querySelectorAll('button, div[role="button"]'),
      );
      const notNowButton = elements.find((el) => {
        const text = el.textContent.trim().toLowerCase();
        return text === "not now";
      });

      if (notNowButton) {
        const parentText = notNowButton.closest("div")?.textContent || "";
        console.log(
          `[Instagram Check] Found "Not Now" button in context: ${parentText.substring(0, 50)}...`,
        );
        notNowButton.click();
        return true;
      }

      return false;
    });

    if (dismissed) {
      console.log(`[Instagram] Dismissed prompt (attempt ${i + 1})`);
      await humanDelay(1000, 2000);
    } else {
      // No more prompts found
      console.log(`[Instagram] No more prompts to dismiss (attempt ${i + 1})`);
      break;
    }
  }
};

// Login to Instagram
const loginToInstagram = async (page) => {
  const username = process.env.INSTAGRAM_USERNAME;
  const password = process.env.INSTAGRAM_PASSWORD;
  const usernameSelector =
    process.env.INSTAGRAM_USERNAME_SELECTOR || 'input[name="username"]';
  const passwordSelector =
    process.env.INSTAGRAM_PASSWORD_SELECTOR || 'input[name="password"]';

  if (!username || !password) {
    throw new Error(
      "Instagram credentials not configured in environment variables",
    );
  }

  console.log("[Instagram] Navigating to login page...");
  await page.goto("https://www.instagram.com/accounts/login/", {
    waitUntil: "networkidle2",
    timeout: 30000,
  });

  await pageLoadDelay();

  // Give extra time for account selection screen to fully render
  await humanDelay(1500, 2500);

  // Check for account selection screen and click "Use another profile"
  console.log("[Instagram] Checking for account selection screen...");

  // Try to wait for the "Use another profile" button (up to 5 seconds)
  let useAnotherProfileClicked = false;
  try {
    await page.waitForSelector(
      '[aria-label="Use another profile"][role="button"]',
      {
        timeout: 5000,
        visible: true,
      },
    );
    console.log(
      '[Instagram] "Use another profile" button detected, clicking...',
    );

    useAnotherProfileClicked = await page.evaluate(() => {
      const useAnotherBtn = document.querySelector(
        '[aria-label="Use another profile"][role="button"]',
      );
      if (useAnotherBtn) {
        console.log('[Instagram] Clicking "Use another profile" button...');
        useAnotherBtn.click();
        return true;
      }
      return false;
    });
  } catch (error) {
    console.log(
      '[Instagram] "Use another profile" button not found within timeout, checking manually...',
    );

    // Fallback: manual search
    useAnotherProfileClicked = await page.evaluate(() => {
      const allButtons = Array.from(
        document.querySelectorAll('[role="button"]'),
      );
      console.log(
        `[Instagram] Manually checking ${allButtons.length} buttons...`,
      );

      for (const btn of allButtons) {
        const btnText = btn.textContent.trim();
        const ariaLabel = btn.getAttribute("aria-label");

        if (
          btnText.includes("Use another profile") ||
          btnText.includes("use another profile") ||
          ariaLabel?.includes("Use another profile")
        ) {
          console.log(`[Instagram] Found match, clicking...`);
          btn.click();
          return true;
        }
      }
      return false;
    });
  }

  if (useAnotherProfileClicked) {
    console.log(
      "[Instagram] Clicked 'Use another profile', waiting for login form...",
    );
    await humanDelay(2000, 3000);
  } else {
    console.log(
      "[Instagram] 'Use another profile' button not found, checking if login form is already visible...",
    );
    await humanDelay(1000, 1500);
  }

  // Check if username and password fields exist
  console.log("[Instagram] Checking for login form fields...");
  const fieldsExist = await page.evaluate(
    (usernameSelector, passwordSelector) => {
      const usernameField = document.querySelector(usernameSelector);
      const passwordField = document.querySelector(passwordSelector);
      return {
        usernameExists: !!usernameField,
        passwordExists: !!passwordField,
        usernameVisible: usernameField && usernameField.offsetParent !== null,
        passwordVisible: passwordField && passwordField.offsetParent !== null,
      };
    },
    usernameSelector,
    passwordSelector,
  );

  console.log(`[Instagram] Login fields status:`, fieldsExist);

  // If neither field exists, throw error
  if (!fieldsExist.usernameExists && !fieldsExist.passwordExists) {
    throw new Error(
      "Login form not found - no username or password fields detected",
    );
  }

  // Wait for fields to be visible if they exist but aren't visible yet
  if (
    (fieldsExist.usernameExists && !fieldsExist.usernameVisible) ||
    (fieldsExist.passwordExists && !fieldsExist.passwordVisible)
  ) {
    console.log("[Instagram] Waiting for login fields to become visible...");
    await humanDelay(1000, 2000);
  }

  // Type username only if field exists (some modals only show password for saved accounts)
  if (fieldsExist.usernameExists && fieldsExist.usernameVisible) {
    console.log("[Instagram] Typing username...");
    await humanType(page, usernameSelector, username, 120);
    await humanDelay(500, 1000);
  } else {
    console.log(
      "[Instagram] Skipping username (field not present - using saved account)",
    );
  }

  // Type password (should always be present)
  if (fieldsExist.passwordExists && fieldsExist.passwordVisible) {
    console.log("[Instagram] Typing password...");
    await humanType(page, passwordSelector, password, 100);
    await humanDelay(800, 1500);
  } else {
    throw new Error("Password field not visible or not found");
  }

  console.log("[Instagram] Clicking login button...");
  // Find and click login button by text content (more reliable than classes)
  const loginClicked = await page.evaluate(() => {
    const buttons = Array.from(
      document.querySelectorAll('button, div[role="button"]'),
    );
    const loginButton = buttons.find(
      (btn) => btn.textContent.trim().toLowerCase() === "log in",
    );
    if (loginButton) {
      loginButton.click();
      return true;
    }
    return false;
  });

  if (!loginClicked) {
    throw new Error("Login button not found");
  }

  // Wait for navigation after login
  await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 });
  await pageLoadDelay();

  // Dismiss any prompts that appear after login (Save Info, Notifications, etc.)
  console.log("[Instagram] Checking for post-login prompts...");
  await dismissPrompts(page, 3);

  console.log("[Instagram] Login successful!");
  return true;
};

// ═══════════════════════════════════════════════════════════════════════════
// GraphQL-based Instagram Scraper (Alternative Method)
// ═══════════════════════════════════════════════════════════════════════════
// List of domains to skip during deep scan (social platforms, tech giants, etc.)
const SKIP_DOMAINS = [
  "apple.com",
  "youtube.com",
  "google.com",
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "tiktok.com",
  "snapchat.com",
  "pinterest.com",
  "reddit.com",
  "amazon.com",
  "ebay.com",
  "paypal.com",
  "github.com",
  "stackoverflow.com",
  "microsoft.com",
  "zoom.us",
  "discord.com",
  "telegram.org",
  "whatsapp.com",
  "spotify.com",
  "netflix.com",
  "t.co",
  "bit.ly",
  "tinyurl.com",
];

const shouldSkipDomain = (url) => {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase().replace(/^www\\./, "");

    // Check if hostname matches or ends with any skip domain
    return SKIP_DOMAINS.some((domain) => {
      return hostname === domain || hostname.endsWith("." + domain);
    });
  } catch (error) {
    return false;
  }
};

const deepScanExternalUrl = async (externalUrl, options = {}) =>
  queuedDeepScanExternalUrl(externalUrl, options);

const enqueueRelationshipDeepScans = ({
  user_id,
  job_id,
  leads = [],
  label = "Instagram",
}) => {
  if (!DEEP_SCAN_RELATIONSHIP_ENABLED || !leads.length) {
    return;
  }

  const scanTargets = leads
    .map((lead) => ({
      lead_id: lead?._id,
      url: lead?.external_url || lead?.external_urls?.[0] || null,
    }))
    .filter((target) => target.lead_id && target.url);

  if (!scanTargets.length) {
    return;
  }

  enqueueDeepScanBatch({
    user_id,
    job_id,
    lead_ids: scanTargets.map((target) => target.lead_id),
    urls: scanTargets.map((target) => target.url),
  }).catch((error) => {
    console.warn(`[DeepScan] ${label} enqueue failed: ${error.message}`);
  });
};

/*
const scrapeWithApify = async (username) => {
  const apifyToken = process.env.APIFY_API_KEY;
  if (!apifyToken) {
    throw new Error("APIFY_API_KEY not configured in environment variables");
  }

  const client = new ApifyClient({ token: apifyToken });

  console.log(`[Apify] Starting scrape for username: ${username}`);

  const input = {
    usernames: [`https://www.instagram.com/${username}/`],
  };

  try {
    const run = await client.actor(APIFY_INSTAGRAM_PROFILE_ACTOR_ID).call(input);
    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    if (!items || items.length === 0) {
      throw new Error("No data returned from Apify");
    }

    console.log("[Apify] Successfully scraped profile");
    return items[0];
  } catch (error) {
    console.log("[Apify] Error:", error.message);
    throw error;
  }
};

const scrapeWithApifyBulk = async (usernames) => {
  const apifyToken = process.env.APIFY_API_KEY;
  if (!apifyToken) {
    throw new Error("APIFY_API_KEY not configured in environment variables");
  }

  const client = new ApifyClient({ token: apifyToken });

  console.log(
    `[Apify Bulk] Starting bulk scrape for ${usernames.length} usernames`,
  );

  const instagramUrls = usernames.map(
    (username) => `https://www.instagram.com/${username}/`,
  );

  const input = {
    usernames: instagramUrls,
  };

  try {
    const run = await client.actor(APIFY_INSTAGRAM_PROFILE_ACTOR_ID).call(input);
    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    if (!items || items.length === 0) {
      throw new Error("No data returned from Apify bulk scrape");
    }

    console.log(`[Apify Bulk] Successfully scraped ${items.length} profiles`);
    return items;
  } catch (error) {
    console.log("[Apify Bulk] Error:", error.message);
    throw error;
  }
};
*/

// Legacy HTML scraper removed. Use scrapeWithInstagramAPI/scrapeWithInstagramAPIBulk.

// ═══════════════════════════════════════════════════════════════════════════
// Instagram JSON API Scraper (i.instagram.com)
// ═══════════════════════════════════════════════════════════════════════════
const scrapeWithInstagramAPI = async (
  username,
  cookieString = null,
  forcedProxyConfig = null,
  { maxRequestRetries = INSTAGRAM_JSON_RETRIES } = {},
) => {
  const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  // const url = `https://i.instagram.com/api/v1/users/${encodeURIComponent(username)}/usernameinfo`;
  // const url = `https://instagram.com/${encodeURIComponent(username)}/?__a=1&__d=dis`;
  const headers = {
    "User-Agent": "Instagram 219.0.0.12.117 Android",
    "X-IG-App-ID": "936619743392459",
    Accept: "application/json",
  };

  if (cookieString) {
    const csrftoken = cookieString.match(/csrftoken=([^;]+)/)?.[1];
    headers["Cookie"] = cookieString;
    if (csrftoken) headers["X-CSRFToken"] = csrftoken;
  }

  console.log(`[InstagramAPI] Fetching profile for @${username} via CheerioCrawler`);

  const responseData = await fetchJsonWithCheerioCrawler({
    url,
    headers,
    label: `instagram-profile-${username}`,
    forcedProxyConfig,
    maxRequestRetries,
    timeoutSecs: 30,
  });

  const user = responseData?.user ?? responseData?.data?.user ?? null;
  console.log(`[InstagramAPI] Received data for @${username}: ${user ? JSON.stringify(user) : "no user data"}`);
  if (!user)
    throw new Error(
      `No user data returned from Instagram API for @${username}`,
    );

  const bio = user.biography || "";
  const bioEmails = extractEmails(bio);
  const bioPhones = extractPhones(bio);

  if (user.business_email) bioEmails.push(user.business_email);
  if (user.business_phone_number) bioPhones.push(user.business_phone_number);

  // Collect external URLs
  const extUrls = (user.bio_links || []).map((l) => l.url).filter(Boolean);
  if (user.external_url && !extUrls.includes(user.external_url))
    extUrls.unshift(user.external_url);

  // Deep-scan external URLs for additional contacts
  let urlEmails = [];
  let urlPhones = [];
  if (DEEP_SCAN_INLINE_SINGLE_PROFILE && extUrls.length > 0) {
    console.log(
      `[InstagramAPI] @${username}: deep-scanning ${extUrls.length} external URL(s)...`,
    );
    for (const extUrl of extUrls) {
      try {
        const scan = await deepScanExternalUrl(extUrl);
        urlEmails.push(...(scan.emails ?? []));
        urlPhones.push(...(scan.phone_numbers ?? []));
      } catch (scanErr) {
        console.log(
          `[InstagramAPI] Deep-scan failed for ${extUrl}: ${scanErr.message}`,
        );
      }
    }
  }

  const allEmails = uniqueValues([...bioEmails, ...urlEmails]);
  const allPhones = uniqueValues([...bioPhones, ...urlPhones]);

  console.log(
    `[InstagramAPI] @${username} → ${allEmails.length} email(s), ${allPhones.length} phone(s)`,
  );

  return {
    id: user.id ?? null,
    username: user.username ?? username,
    fullName: user.full_name ?? null,
    biography: bio,
    followersCount: user.edge_followed_by?.count ?? null,
    followsCount: user.edge_follow?.count ?? null,
    postsCount: user.edge_owner_to_timeline_media?.count ?? null,
    profilePicUrl: user.profile_pic_url ?? null,
    profilePicUrlHD: user.profile_pic_url_hd ?? null,
    externalUrl: user.external_url ?? null,
    externalUrlShimmed: user.external_url_linkshimmed ?? null,
    externalUrls: extUrls.map((u) => ({ url: u })),
    verified: user.is_verified ?? false,
    private: user.is_private ?? false,
    businessCategoryName: user.business_category_name ?? null,
    emails: allEmails,
    phone_numbers: allPhones,
  };
};

// Bulk version of scrapeWithInstagramAPI
const scrapeWithInstagramAPIBulk = async (
  usernames,
  cookieString = null,
  options = {},
) => {
  const context = {
    jobType: normalizeJobType(options?.context?.jobType || "bulk_profiles"),
    jobId: options?.context?.jobId || null,
    userId: options?.context?.userId || null,
  };

  const enrichment = await enrichProfiles(usernames, {
    context,
    chunkSize: options.chunkSize || 50,
    maxChunkSize: options.maxChunkSize || 50,
    cachedUsernames: options.cachedUsernames,
    budgetUsd: options.budgetUsd,
    allowSingleAsFinalLeftover: Boolean(options.allowSingleAsFinalLeftover),
    onChunkComplete: options.onChunkComplete,
  });

  if (options.returnMeta) {
    return enrichment;
  }

  if (enrichment.stage === "SKIPPED_COST_LIMIT") {
    console.warn(
      `[InstagramAPI Bulk] Skipped due to cost limit (estimated=${enrichment.estimatedCost}, budget=${enrichment.budgetUsd})`,
    );
    return [];
  }

  return enrichment.profiles || [];
};

// ═══════════════════════════════════════════════════════════════════════════
// SteadyAPI Fallback
// ═══════════════════════════════════════════════════════════════════════════
const emitScrapeRealtime = ({
  userId,
  event,
  payload = {},
  label = "Instagram GraphQL",
}) => {
  if (!userId || !event) return;

  try {
    const io = getIO();
    io.to(`user:${userId}`).emit(event, {
      event,
      user_id: userId,
      ...payload,
      ts: Date.now(),
    });
  } catch (wsErr) {
    console.warn(`[${label}] WebSocket emit failed (non-fatal): ${wsErr.message}`);
  }
};

const parseRetryAfterMs = (retryAfterHeader) => {
  if (!retryAfterHeader) return null;

  const seconds = Number(retryAfterHeader);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(retryAfterHeader);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return null;
};

const getProfileDetailRateLimitDelayMs = (error, attempt) => {
  const retryAfterMs = parseRetryAfterMs(
    error?.response?.headers?.["retry-after"],
  );
  const exponentialMs =
    PROFILE_DETAIL_RATE_LIMIT_BACKOFF_BASE_MS *
    2 ** Math.max(0, attempt - 1);
  const cappedMs = Math.min(
    PROFILE_DETAIL_RATE_LIMIT_BACKOFF_MAX_MS,
    Math.max(retryAfterMs || 0, exponentialMs),
  );
  const jitterMs = Math.floor(Math.random() * 10_000);

  return cappedMs + jitterMs;
};

const delayAfterProfileDetailRequest = async () => {
  if (PROFILE_DETAIL_BATCH_DELAY_MAX_MS <= 0) return;
  await humanDelay(
    PROFILE_DETAIL_BATCH_DELAY_MIN_MS,
    PROFILE_DETAIL_BATCH_DELAY_MAX_MS,
  );
};

const mapGraphQLUserWithProfile = (user, profile = null, error = null) => ({
  id: profile?.id || user.id,
  username: profile?.username || user.username,
  followers: profile?.followersCount ?? null,
  following: profile?.followsCount ?? null,
  bio: profile?.biography || null,
  category: profile?.businessCategoryName || null,
  avatar: profile?.profilePicUrlHD || profile?.profilePicUrl || user.profile_pic_url,
  full_name: profile?.fullName || user.full_name || null,
  is_verified: profile?.verified ?? user.is_verified ?? false,
  is_private: profile?.private ?? user.is_private ?? false,
  external_url: profile?.externalUrl || null,
  posts_count: profile?.postsCount ?? null,
  emails: uniqueValues(profile?.emails || []),
  phone_numbers: uniqueValues(profile?.phone_numbers || []),
  ...(error ? { error: error.message } : {}),
});

const buildInstagramRelationshipLeadPayload = ({
  user,
  type,
  targetUsername,
  scrapingMethod = "GraphQL API",
}) => {
  const { first_name, last_name } = splitName(user.full_name || "");

  return {
    first_name,
    last_name,
    company: user.username || "",
    emails: user.emails || [],
    phone_numbers: user.phone_numbers || [],
    message: `
${relationshipScrapeTitle(type)} (${scrapingMethod})

Target Profile: @${targetUsername}
Username: @${user.username || "N/A"}
Full Name: ${user.full_name || "N/A"}
Bio: ${user.bio || "N/A"}
Followers: ${user.followers || "N/A"}
Following: ${user.following || "N/A"}
Posts: ${user.posts_count || "N/A"}
Verified: ${user.is_verified ? "Yes" : "No"}
Private: ${user.is_private ? "Yes" : "No"}
Category: ${user.category || "N/A"}
Profile URL: https://www.instagram.com/${user.username}
Scraping Method: ${scrapingMethod}
${user.emails && user.emails.length > 0 ? `Emails: ${user.emails.join(", ")}` : ""}
${user.phone_numbers && user.phone_numbers.length > 0 ? `Phone Numbers: ${user.phone_numbers.join(", ")}` : ""}
    `.trim(),
    scraped_from_username: targetUsername,
    relationship_type: toRelationshipDirection(type),
    source_url: `https://www.instagram.com/${user.username}`,
    source_rul: `https://www.instagram.com/${user.username}`,
    instagram_profile_id: user.id !== user.username ? user.id : null,
    username: user.username,
    full_name: user.full_name,
    bio: user.bio,
    avatar_url: user.avatar,
    avatar_rul: user.avatar,
    followers: user.followers,
    following: user.following,
    follower_count: user.followers,
    following_count: user.following,
    total_posts: user.posts_count,
    category: user.category,
    external_url: user.external_url,
    external_url_linkshimmed: null,
    external_urls: user.external_url ? [user.external_url] : [],
    is_private: user.is_private,
    is_verified: user.is_verified,
    is_public: user.is_private !== null ? !user.is_private : null,
    fb_profile_biolink: null,
    highlight_reel_count: null,
    links: [],
    scrape_status: true,
    type: "INSTAGRAM",
  };
};

const fetchProfileDetailWithAdaptiveBackoff = async ({
  user,
  cookieString,
  sessionProxyConfig,
  batchNumber,
}) => {
  for (let attempt = 1; attempt <= PROFILE_DETAIL_RATE_LIMIT_MAX_ATTEMPTS; attempt++) {
    try {
      const profile = await scrapeWithInstagramAPI(
        user.username,
        cookieString,
        sessionProxyConfig,
        { maxRequestRetries: 0 },
      );
      return mapGraphQLUserWithProfile(user, profile);
    } catch (error) {
      if (isRateLimitError(error)) {
        if (attempt >= PROFILE_DETAIL_RATE_LIMIT_MAX_ATTEMPTS) {
          console.warn(
            `[Instagram GraphQL] Batch #${batchNumber}: web_profile_info still rate-limited for @${user.username} after ${attempt} attempt(s)`,
          );
          throw error;
        }

        const waitMs = getProfileDetailRateLimitDelayMs(error, attempt);
        console.warn(
          `[Instagram GraphQL] Batch #${batchNumber}: 429 while fetching @${user.username}; waiting ${Math.round(waitMs / 1000)}s before retry ${attempt + 1}/${PROFILE_DETAIL_RATE_LIMIT_MAX_ATTEMPTS}`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      if (isAuthError(error)) {
        throw error;
      }

      console.warn(
        `[Instagram GraphQL] web_profile_info failed for @${user.username}; using GraphQL fallback: ${error.message}`,
      );
      return mapGraphQLUserWithProfile(user, null, error);
    }
  }

  return mapGraphQLUserWithProfile(user, null);
};

const enrichGraphQLBatchWithInstagramAPI = async ({
  users,
  cookieString,
  sessionProxyConfig,
  batchNumber,
  relationshipType,
  jobId,
  userId,
  processedCountBeforeBatch = 0,
}) => {
  const enrichedUsers = [];
  const startedAt = Date.now();
  let chunksProcessedInBatch = 0;

  const queryName =
    relationshipType === "following"
      ? "edge_follow"
      : "edge_followed_by";

  console.log(
    JSON.stringify({
      event: "instagram_query_batch_started",
      job_id: jobId || null,
      query_name: queryName,
      batch_number: batchNumber,
      result_count: users.length,
      total_count: null,
    }),
  );

  const usernameList = users.map((user) => user.username).filter(Boolean);
  const apifyResult = await scrapeWithInstagramAPIBulk(usernameList, cookieString, {
    context: {
      jobType: relationshipType === "following" ? "following" : "followers",
      jobId,
      userId,
    },
    // Hard enforce 50-sized chunks for relationship enrichment.
    chunkSize: 50,
    maxChunkSize: 50,
    allowSingleAsFinalLeftover: processedCountBeforeBatch > 0,
    returnMeta: true,
    onChunkComplete: ({ chunkIndex, inputCount, outputCount, metricsSnapshot }) => {
      chunksProcessedInBatch += 1;
      emitScrapeRealtime({
        userId,
        event: "scrape:enrichment_chunk",
        payload: {
          job_id: jobId || null,
          type: relationshipType,
          batch_number: batchNumber,
          chunk_index: chunkIndex,
          chunk_input_count: inputCount,
          chunk_output_count: outputCount,
          chunks_processed_in_batch: chunksProcessedInBatch,
          ...metricsSnapshot,
        },
      });
    },
  });

  const profileMap = apifyResult.profileByUsername || new Map();

  for (const user of users) {
    const profile = profileMap.get(String(user.username || "").toLowerCase()) || null;
    enrichedUsers.push(mapGraphQLUserWithProfile(user, profile));
  }

  if (apifyResult.stage === "SKIPPED_COST_LIMIT") {
    console.warn(
      `[Instagram GraphQL] Skipping Apify enrichment due to cost limit (estimated=${apifyResult.estimatedCost}, budget=${apifyResult.budgetUsd})`,
    );
  }

  console.log(
    JSON.stringify({
      event: "instagram_query_batch_finished",
      job_id: jobId || null,
      query_name: queryName,
      result_count: enrichedUsers.length,
      total_count: null,
      elapsed_ms: Date.now() - startedAt,
      apify_metrics: apifyResult.metrics,
      enrichment_stage: apifyResult.stage,
    }),
  );

  return enrichedUsers;
};

const saveInstagramRelationshipBatch = async ({
  enrichedUsers,
  user_id,
  folder_id,
  targetUsername,
  type,
  jobId = null,
}) => {
  if (!enrichedUsers.length) {
    return {
      insertedLeads: [],
      cachedCount: 0,
      newCount: 0,
      linkedCount: 0,
    };
  }

  let reservedCredits = 0;
  const leadsToInsert = enrichedUsers.map((user) =>
    buildInstagramRelationshipLeadPayload({
      user,
      type,
      targetUsername,
      scrapingMethod: "GraphQL API + web_profile_info",
    }),
  );

  try {
    reservedCredits = await reserveScrapedProfileCredits(
      user_id,
      leadsToInsert.length,
    );

    const bulkResult = await userLeadService.bulkResolveOrCreate(
      leadsToInsert,
      {
        user_id,
        folder_id,
        type: "INSTAGRAM",
        scraped_from_username: targetUsername,
        relationship_type: toRelationshipDirection(type),
      },
    );

    await refundUnusedScrapedProfileCredits(
      user_id,
      reservedCredits,
      bulkResult.insertedLeads.length,
    );
    enqueueRelationshipDeepScans({
      user_id,
      job_id: jobId,
      leads: bulkResult.insertedLeads,
      label: "Instagram GraphQL",
    });
    console.log(
      `[Instagram] Done — new: ${bulkResult.newCount}, from cache: ${bulkResult.cachedCount}`,
    );
    return {
      insertedLeads: bulkResult.insertedLeads,
      cachedCount: bulkResult.cachedCount,
      newCount: bulkResult.newCount,
      linkedCount: bulkResult.userLeads?.insertedCount || 0,
    };
  } catch (error) {
    await refundUnusedScrapedProfileCredits(user_id, reservedCredits, 0);
    throw error;
  }
};

const scrapeWithSteadyAPI = async (username) => {
  console.log(`[SteadyAPI] Fallback scrape for username: ${username}`);

  try {
    const response = await axios.get(
      `https://api.steadyapi.com/v1/instagram/profile?username=${username}`,
      {
        timeout: 30000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      },
    );

    if (!response.data?.body) {
      throw new Error("Invalid response from SteadyAPI");
    }

    console.log("[SteadyAPI] Successfully scraped profile");
    return response.data.body;
  } catch (error) {
    console.log("[SteadyAPI] Error:", error.message);
    throw error;
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Transform Apify Response to Lead Format
// ═══════════════════════════════════════════════════════════════════════════
const transformApifyToLead = (apifyData) => {
  const { first_name, last_name } = splitName(apifyData.fullName);

  // Extract emails and phones from bio
  const bioEmails = extractEmails(apifyData.biography || "");
  const bioPhones = extractPhones(apifyData.biography || "");

  // Extract external URLs
  const externalUrls = uniqueValues(
    [
      apifyData.externalUrl,
      ...(Array.isArray(apifyData.externalUrls)
        ? apifyData.externalUrls.map((link) => link.url).filter(Boolean)
        : []),
    ].filter(Boolean),
  );

  // Build profile data structure
  const profileData = {
    instagram_profile_id: apifyData.id || null,
    username: apifyData.username || null,
    full_name: apifyData.fullName || null,
    bio: apifyData.biography || null,
    avatar_url: apifyData.profilePicUrlHD || apifyData.profilePicUrl || null,
    followers: parseCount(apifyData.followersCount),
    following: parseCount(apifyData.followsCount),
    total_posts: parseCount(apifyData.postsCount),
    category: apifyData.businessCategoryName || null,
    external_url: apifyData.externalUrl || null,
    external_url_linkshimmed: apifyData.externalUrlShimmed || null,
    external_urls: externalUrls,
    is_private: apifyData.private ?? null,
    is_verified: apifyData.verified ?? null,
    is_public: apifyData.private !== null ? !apifyData.private : null,
    highlight_reel_count: parseCount(apifyData.highlightReelCount),
    links: Array.isArray(apifyData.externalUrls) ? apifyData.externalUrls : [],
    source_url:
      apifyData.url || `https://www.instagram.com/${apifyData.username}`,
  };

  return {
    profileData,
    first_name,
    last_name,
    bioEmails,
    bioPhones,
    externalUrls,
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// Transform SteadyAPI Response to Lead Format
// ═══════════════════════════════════════════════════════════════════════════
const transformSteadyAPIToLead = (steadyData) => {
  const { first_name, last_name } = splitName(steadyData.full_name);

  const bioEmails = extractEmails(steadyData.biography || "");
  const bioPhones = extractPhones(steadyData.biography || "");

  const externalUrls = uniqueValues(
    [
      steadyData.external_url,
      ...(Array.isArray(steadyData.bio_links)
        ? steadyData.bio_links.map((link) => link.url).filter(Boolean)
        : []),
    ].filter(Boolean),
  );

  const profileData = {
    instagram_profile_id: steadyData.id || null,
    username: steadyData.username || null,
    full_name: steadyData.full_name || null,
    bio: steadyData.biography || null,
    avatar_url: steadyData.profile_pic_hd || steadyData.profile_pic || null,
    followers: parseCount(steadyData.followers),
    following: parseCount(steadyData.following),
    total_posts: parseCount(steadyData.posts),
    category: steadyData.category || null,
    external_url: steadyData.external_url || null,
    external_url_linkshimmed: null,
    external_urls: externalUrls,
    is_private: steadyData.is_private ?? null,
    is_verified: steadyData.is_verified ?? null,
    is_public: steadyData.is_private !== null ? !steadyData.is_private : null,
    highlight_reel_count: parseCount(steadyData.highlight_reel_count),
    links: Array.isArray(steadyData.bio_links) ? steadyData.bio_links : [],
    source_url:
      steadyData.profile_url ||
      `https://www.instagram.com/${steadyData.username}`,
  };

  return {
    profileData,
    first_name,
    last_name,
    bioEmails,
    bioPhones,
    externalUrls,
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// Main Function: Scrape Instagram Profile
// ═══════════════════════════════════════════════════════════════════════════
const scrapeInstagram = async ({ profileUrl, user_id, folder_id }) => {
  if (!profileUrl) {
    return {
      code: 400,
      success: false,
      message: "instagram-profile-url-is-required",
    };
  }

  // Extract username from URL
  let username;
  try {
    const url = new URL(profileUrl);
    username = url.pathname.split("/").filter(Boolean)[0];
    if (!username) {
      throw new Error("Invalid Instagram URL");
    }
  } catch (error) {
    return {
      code: 400,
      success: false,
      message: "invalid-instagram-url",
      error: error.message,
    };
  }

  let profileData;
  let first_name, last_name, bioEmails, bioPhones, externalUrls;
  let scrapedWith = "instagram-api";

  // Try Instagram API first
  try {
    const apifyData = await scrapeWithInstagramAPI(username);
    const transformed = transformApifyToLead(apifyData);
    profileData = transformed.profileData;
    first_name = transformed.first_name;
    last_name = transformed.last_name;
    bioEmails = transformed.bioEmails;
    bioPhones = transformed.bioPhones;
    externalUrls = transformed.externalUrls;
  } catch (apifyError) {
    console.log("[Main] Instagram API failed, trying SteadyAPI fallback");

    // Fallback to SteadyAPI
    try {
      const steadyData = await scrapeWithSteadyAPI(username);
      const transformed = transformSteadyAPIToLead(steadyData);
      profileData = transformed.profileData;
      first_name = transformed.first_name;
      last_name = transformed.last_name;
      bioEmails = transformed.bioEmails;
      bioPhones = transformed.bioPhones;
      externalUrls = transformed.externalUrls;
      scrapedWith = "steadyapi";
    } catch (steadyError) {
      console.log("[Main] Both Apify and SteadyAPI failed");
      return {
        code: 500,
        success: false,
        message: "failed-to-scrape-instagram-profile",
        errors: {
          apify: apifyError.message,
          steadyapi: steadyError.message,
        },
      };
    }
  }

  // Perform deep scan on external URLs
  let deepScanResults = [];
  let allEmails = [...bioEmails];
  let allPhones = [...bioPhones];
  let skippedCount = 0;

  if (DEEP_SCAN_INLINE_SINGLE_PROFILE && externalUrls.length > 0) {
    console.log(`[Main] Starting deep scan for ${externalUrls.length} URLs`);

    for (const url of externalUrls) {
      const scanResult = await deepScanExternalUrl(url);

      if (scanResult.skipped) {
        skippedCount++;
      }

      deepScanResults.push(scanResult);

      if (scanResult.emails.length > 0) {
        allEmails.push(...scanResult.emails);
      }
      if (scanResult.phone_numbers.length > 0) {
        allPhones.push(...scanResult.phone_numbers);
      }

      // Small delay between requests
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    console.log(
      `[Main] Deep scan completed. Scanned: ${externalUrls.length - skippedCount}, Skipped: ${skippedCount}`,
    );
  }

  // Unique values
  allEmails = uniqueValues(allEmails);
  allPhones = uniqueValues(allPhones);

  // Create or reuse Lead + link via UserLead (dedup-aware)
  try {
    const leadPayload = {
      first_name,
      last_name,
      company: profileData.username || "",
      emails: allEmails,
      phone_numbers: allPhones,
      message: `
Instagram Profile Scraped

Username: ${profileData.username || "N/A"}
Full Name: ${profileData.full_name || "N/A"}
Bio: ${profileData.bio || "N/A"}
Followers: ${profileData.followers || "N/A"}
Following: ${profileData.following || "N/A"}
Profile URL: ${profileData.source_url}
Scraped with: ${scrapedWith.toUpperCase()}
      `.trim(),
      source_url: profileData.source_url,
      source_rul: profileData.source_url,
      instagram_profile_id: profileData.instagram_profile_id,
      username: profileData.username,
      full_name: profileData.full_name,
      bio: profileData.bio,
      avatar_url: profileData.avatar_url,
      avatar_rul: profileData.avatar_url,
      followers: profileData.followers,
      following: profileData.following,
      follower_count: profileData.followers,
      following_count: profileData.following,
      total_posts: profileData.total_posts,
      category: profileData.category,
      external_url: profileData.external_url,
      external_url_linkshimmed: profileData.external_url_linkshimmed,
      external_urls: profileData.external_urls,
      is_private: profileData.is_private,
      is_verified: profileData.is_verified,
      is_public: profileData.is_public,
      fb_profile_biolink: null,
      highlight_reel_count: null,
      links: profileData.links,
      scrape_status: true,
      type: "INSTAGRAM",
    };

    const { lead, fromCache } = await userLeadService.resolveOrCreateLead(
      leadPayload,
      { user_id, folder_id, type: "INSTAGRAM" },
    );

    if (!DEEP_SCAN_INLINE_SINGLE_PROFILE && externalUrls.length > 0) {
      enqueueDeepScanBatch({
        user_id,
        lead_ids: externalUrls.map(() => lead?._id),
        urls: externalUrls,
        job_id: null,
      }).catch((error) => {
        console.warn(
          `[DeepScan] enqueue failed for @${profileData.username}: ${error.message}`,
        );
      });
    }

    return {
      code: 200,
      success: true,
      message: fromCache
        ? "instagram-profile-fetched-from-cache"
        : "instagram-profile-scraped-successfully",
      scraped_with: scrapedWith,
      from_cache: fromCache,
      data: {
        lead,
        profile: profileData,
        deep_scan: {
          scanned_urls: deepScanResults.length,
          results: deepScanResults,
          total_emails_found: allEmails.length,
          total_phones_found: allPhones.length,
        },
      },
    };
  } catch (dbError) {
    console.error("[Main] Database error:", dbError);
    return {
      code: 500,
      success: false,
      message: "failed-to-save-lead-to-database",
      error: dbError.message,
    };
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Bulk Instagram Profile Scraper
// ═══════════════════════════════════════════════════════════════════════════
const scrapeInstagramBulk = async ({ profileUrls, user_id, folder_id }) => {
  if (!profileUrls || !Array.isArray(profileUrls) || profileUrls.length === 0) {
    return {
      code: 400,
      success: false,
      message: "profileUrls array is required and cannot be empty",
    };
  }

  console.log(`[Bulk] Starting bulk scrape for ${profileUrls.length} profiles`);

  // Extract all usernames from profile URLs
  const usernames = [];
  const usernameToUrlMap = new Map();

  for (const profileUrl of profileUrls) {
    const username = profileUrl
      .replace(/https?:\/\/(www\.)?instagram\.com\//gi, "")
      .replace(/\/$/, "")
      .trim();

    if (username) {
      usernames.push(username);
      usernameToUrlMap.set(username.toLowerCase(), profileUrl);
    }
  }

  if (usernames.length === 0) {
    return {
      code: 400,
      success: false,
      message: "No valid usernames found in profileUrls",
    };
  }

  console.log(`[Bulk] Extracted ${usernames.length} valid usernames`);

  const results = [];
  const leadsToInsert = [];
  let successCount = 0;
  let failCount = 0;

  try {
    // Fetch profiles via Instagram API
    console.log(
      `[Bulk] Sending request to Instagram API for ${usernames.length} profiles...`,
    );
    const apifyBulkData = await scrapeWithInstagramAPIBulk(usernames, null, {
      context: {
        jobType: "bulk_profiles",
        userId: user_id || null,
      },
    });

    // Process each result from Apify
    for (const apifyData of apifyBulkData) {
      try {
        const transformed = transformApifyToLead(apifyData);
        const {
          profileData,
          first_name,
          last_name,
          bioEmails,
          bioPhones,
          externalUrls,
        } = transformed;

        // Unique values
        const allEmails = uniqueValues(bioEmails);
        const allPhones = uniqueValues(bioPhones);

        // Get original profile URL
        const originalUrl =
          usernameToUrlMap.get(profileData.username?.toLowerCase()) ||
          profileData.source_url;

        // Prepare lead data for bulk insert
        const leadData = {
          first_name,
          last_name,
          company: profileData.username || "",
          emails: allEmails,
          phone_numbers: allPhones,
          message: `
Instagram Profile Scraped (Bulk)

Username: ${profileData.username || "N/A"}
Full Name: ${profileData.full_name || "N/A"}
Bio: ${profileData.bio || "N/A"}
Followers: ${profileData.followers || "N/A"}
Following: ${profileData.following || "N/A"}
Profile URL: ${profileData.source_url}
Scraped with: APIFY
          `.trim(),
          source_url: profileData.source_url,
          source_rul: profileData.source_url,
          instagram_profile_id: profileData.instagram_profile_id,
          username: profileData.username,
          full_name: profileData.full_name,
          bio: profileData.bio,
          avatar_url: profileData.avatar_url,
          avatar_rul: profileData.avatar_url,
          followers: profileData.followers,
          following: profileData.following,
          follower_count: profileData.followers,
          following_count: profileData.following,
          total_posts: profileData.total_posts,
          category: profileData.category,
          external_url: profileData.external_url,
          external_url_linkshimmed: null,
          external_urls: profileData.external_urls,
          is_private: profileData.is_private,
          is_verified: profileData.is_verified,
          is_public: profileData.is_public,
          fb_profile_biolink: null,
          highlight_reel_count: null,
          links: profileData.links,
          scrape_status: true,
          type: "INSTAGRAM",
        };

        leadsToInsert.push(leadData);

        results.push({
          profileUrl: originalUrl,
          username: profileData.username,
          success: true,
          scraped_with: "apify",
          profile: profileData,
        });

        successCount++;
      } catch (transformError) {
        console.error(
          `[Bulk] Error transforming profile data:`,
          transformError.message,
        );
        results.push({
          profileUrl: apifyData.url || "unknown",
          username: apifyData.username || "unknown",
          success: false,
          error: transformError.message,
        });
        failCount++;
      }
    }

    console.log(
      `[Bulk] Processed ${successCount} profiles successfully, ${failCount} failed`,
    );
  } catch (apifyError) {
    console.error(`[Bulk] Apify bulk scrape failed:`, apifyError.message);

    // If bulk Apify fails, mark all as failed
    for (const username of usernames) {
      results.push({
        profileUrl: usernameToUrlMap.get(username.toLowerCase()),
        username: username,
        success: false,
        error: apifyError.message,
      });
      failCount++;
    }
  }

  // Bulk insert all leads into MongoDB
  let insertedLeads = [];
  if (leadsToInsert.length > 0) {
    try {
      console.log(
        `[Bulk] Inserting ${leadsToInsert.length} leads into database...`,
      );
      insertedLeads = await Lead.insertMany(leadsToInsert, { ordered: false });
      console.log(`[Bulk] Successfully inserted ${insertedLeads.length} leads`);
    } catch (dbError) {
      console.error("[Bulk] Database bulk insert error:", dbError.message);
      // Even if some fail, insertMany with ordered:false will continue
      // Check if any were inserted
      if (dbError.insertedDocs) {
        insertedLeads = dbError.insertedDocs;
      }
    }
  }

  return {
    code: 200,
    success: true,
    message: "bulk-instagram-scraping-completed",
    data: {
      total: profileUrls.length,
      success: successCount,
      failed: failCount,
      leads_inserted: insertedLeads.length,
      results: results,
      leads: insertedLeads,
    },
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// Instagram Browser Automation - Followers/Following Scraper
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════

const activeRelationshipLocks = new Map();

const buildRelationshipLockKey = ({ jobId, userId, targetUsername, type }) => {
  if (jobId) return `instagram:scrape:${jobId}`;
  return [
    "instagram:relationship",
    userId || "anonymous",
    String(targetUsername || "").trim().toLowerCase() || "unknown-target",
    normalizeRelationshipRequestType(type),
  ].join(":");
};

const acquireRelationshipLock = (context) => {
  const lockKey = buildRelationshipLockKey(context);
  if (activeRelationshipLocks.has(lockKey)) {
    return { acquired: false, lockKey };
  }

  activeRelationshipLocks.set(lockKey, {
    ...context,
    acquiredAt: Date.now(),
  });

  return { acquired: true, lockKey };
};

const releaseRelationshipLock = (lockKey) => {
  if (lockKey) activeRelationshipLocks.delete(lockKey);
};

// ═══════════════════════════════════════════════════════════════════════════
// RESOURCE LIMITS - Safe limits for EC2 micro (1GB RAM)
// ═══════════════════════════════════════════════════════════════════════════
const SAFE_SCRAPE_LIMIT = 300; // Max users to scrape per session (memory safe)
const ENRICH_LIMIT = 100; // Max users to enrich with Apify (API safe)

// Human-like delay helper
const humanDelay = (min = 1000, max = 3000) => {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, delay));
};

// Longer delay for page loads
const pageLoadDelay = () => humanDelay(2000, 4000);

// Gentle scroll delay
const scrollDelay = () => humanDelay(800, 1500);

// Type like a human
const humanType = async (page, selector, text, delayBetweenKeys = 100) => {
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

// Save cookies to file
// Save cookies to file
const saveCookies = async (page, filepath) => {
  const cookies = await page.cookies();

  // Ensure directory exists
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[Instagram] Created directory: ${dir}`);
  }

  fs.writeFileSync(filepath, JSON.stringify(cookies, null, 2));
  console.log(`[Instagram] Cookies saved to ${filepath}`);
};

// Load cookies from file
const loadCookies = async (page, filepath) => {
  if (fs.existsSync(filepath)) {
    const cookies = JSON.parse(fs.readFileSync(filepath, "utf-8"));
    await page.setCookie(...cookies);
    console.log(`[Instagram] Cookies loaded from ${filepath}`);
    return true;
  }
  return false;
};

// Check if logged in
const isLoggedIn = async (page) => {
  try {
    // Wait a bit for page to settle
    await humanDelay(1500, 2500);

    console.log("[Instagram] Running login detection checks...");

    // PRIORITY 1: Positive check - Look for elements that only appear when logged in
    const loggedInIndicator = await page.evaluate(() => {
      // Check for nav bar elements (home, search, etc.)
      const nav = document.querySelector("nav");
      if (nav) {
        // Look for home link or user menu or svg icons (indicating logged-in nav)
        const hasHomeLink = nav.querySelector('a[href="/"]');
        const hasSvg = nav.querySelector("svg");
        const hasProfileLink = nav.textContent
          .toLowerCase()
          .includes("profile");

        if ((hasHomeLink && hasSvg) || hasProfileLink) {
          console.log("[Instagram Check] Found logged-in navigation elements");
          return true;
        }
      }

      // Check for search bar or create post elements
      const hasSearchOrCreate =
        document.querySelector('input[placeholder*="Search"]') ||
        document.querySelector('[aria-label*="New post"]') ||
        document.querySelector('[aria-label*="Create"]');
      if (hasSearchOrCreate) {
        console.log("[Instagram Check] Found search/create elements");
        return true;
      }

      return false;
    });

    if (loggedInIndicator) {
      console.log(
        "[Instagram] ✓ Detected logged-in state (positive indicators)",
      );
      return true;
    }

    // PRIORITY 2: Check for login page URL
    const currentUrl = page.url();
    if (currentUrl.includes("/accounts/login")) {
      console.log("[Instagram] ✗ On login page - not logged in");
      return false;
    }

    // PRIORITY 3: Check for "Log in" dialog/modal (appears on profile pages when not logged in)
    const loginDialog = await page.evaluate(() => {
      const dialogs = document.querySelectorAll('div[role="dialog"]');
      for (const dialog of dialogs) {
        if (
          dialog.textContent.includes("Log in") ||
          dialog.textContent.includes("Sign up for Instagram")
        ) {
          console.log("[Instagram Check] Found login dialog");
          return true;
        }
      }
      return false;
    });

    if (loginDialog) {
      console.log("[Instagram] ✗ Detected login dialog - not logged in");
      return false;
    }

    // PRIORITY 4: Check for login form inputs (last resort)
    const emailInput = await page.$('input[name="email"]');
    const usernameInput = await page.$('input[name="username"]');
    const passwordInput = await page.$(
      'input[name="pass"], input[name="password"]',
    );

    if ((emailInput || usernameInput) && passwordInput) {
      console.log("[Instagram] ✗ Detected login form - not logged in");
      return false;
    }

    // If we reach here and found no negative indicators, assume logged in
    console.log("[Instagram] ✓ No login indicators found - assuming logged in");
    return true;
  } catch (error) {
    console.log("[Instagram] Error checking login status:", error.message);
    return false;
  }
};

// Dismiss Instagram prompts/dialogs (Save Login Info, Notifications, etc.)
const dismissPrompts = async (page, maxAttempts = 3) => {
  for (let i = 0; i < maxAttempts; i++) {
    await humanDelay(1000, 2000);

    const dismissed = await page.evaluate(() => {
      // Find "Not Now" buttons
      const elements = Array.from(
        document.querySelectorAll('button, div[role="button"]'),
      );
      const notNowButton = elements.find((el) => {
        const text = el.textContent.trim().toLowerCase();
        return text === "not now";
      });

      if (notNowButton) {
        const parentText = notNowButton.closest("div")?.textContent || "";
        console.log(
          `[Instagram Check] Found "Not Now" button in context: ${parentText.substring(0, 50)}...`,
        );
        notNowButton.click();
        return true;
      }

      return false;
    });

    if (dismissed) {
      console.log(`[Instagram] Dismissed prompt (attempt ${i + 1})`);
      await humanDelay(1000, 2000);
    } else {
      // No more prompts found
      console.log(`[Instagram] No more prompts to dismiss (attempt ${i + 1})`);
      break;
    }
  }
};

// Login to Instagram
const loginToInstagram = async (page) => {
  const username = process.env.INSTAGRAM_USERNAME;
  const password = process.env.INSTAGRAM_PASSWORD;
  const usernameSelector =
    process.env.INSTAGRAM_USERNAME_SELECTOR || 'input[name="username"]';
  const passwordSelector =
    process.env.INSTAGRAM_PASSWORD_SELECTOR || 'input[name="password"]';

  if (!username || !password) {
    throw new Error(
      "Instagram credentials not configured in environment variables",
    );
  }

  console.log("[Instagram] Navigating to login page...");
  await page.goto("https://www.instagram.com/accounts/login/", {
    waitUntil: "networkidle2",
    timeout: 30000,
  });

  await pageLoadDelay();

  // Give extra time for account selection screen to fully render
  await humanDelay(1500, 2500);

  // Check for account selection screen and click "Use another profile"
  console.log("[Instagram] Checking for account selection screen...");

  // Try to wait for the "Use another profile" button (up to 5 seconds)
  let useAnotherProfileClicked = false;
  try {
    await page.waitForSelector(
      '[aria-label="Use another profile"][role="button"]',
      {
        timeout: 5000,
        visible: true,
      },
    );
    console.log(
      '[Instagram] "Use another profile" button detected, clicking...',
    );

    useAnotherProfileClicked = await page.evaluate(() => {
      const useAnotherBtn = document.querySelector(
        '[aria-label="Use another profile"][role="button"]',
      );
      if (useAnotherBtn) {
        console.log('[Instagram] Clicking "Use another profile" button...');
        useAnotherBtn.click();
        return true;
      }
      return false;
    });
  } catch (error) {
    console.log(
      '[Instagram] "Use another profile" button not found within timeout, checking manually...',
    );

    // Fallback: manual search
    useAnotherProfileClicked = await page.evaluate(() => {
      const allButtons = Array.from(
        document.querySelectorAll('[role="button"]'),
      );
      console.log(
        `[Instagram] Manually checking ${allButtons.length} buttons...`,
      );

      for (const btn of allButtons) {
        const btnText = btn.textContent.trim();
        const ariaLabel = btn.getAttribute("aria-label");

        if (
          btnText.includes("Use another profile") ||
          btnText.includes("use another profile") ||
          ariaLabel?.includes("Use another profile")
        ) {
          console.log(`[Instagram] Found match, clicking...`);
          btn.click();
          return true;
        }
      }
      return false;
    });
  }

  if (useAnotherProfileClicked) {
    console.log(
      "[Instagram] Clicked 'Use another profile', waiting for login form...",
    );
    await humanDelay(2000, 3000);
  } else {
    console.log(
      "[Instagram] 'Use another profile' button not found, checking if login form is already visible...",
    );
    await humanDelay(1000, 1500);
  }

  // Check if username and password fields exist
  console.log("[Instagram] Checking for login form fields...");
  const fieldsExist = await page.evaluate(
    (usernameSelector, passwordSelector) => {
      const usernameField = document.querySelector(usernameSelector);
      const passwordField = document.querySelector(passwordSelector);
      return {
        usernameExists: !!usernameField,
        passwordExists: !!passwordField,
        usernameVisible: usernameField && usernameField.offsetParent !== null,
        passwordVisible: passwordField && passwordField.offsetParent !== null,
      };
    },
    usernameSelector,
    passwordSelector,
  );

  console.log(`[Instagram] Login fields status:`, fieldsExist);

  // If neither field exists, throw error
  if (!fieldsExist.usernameExists && !fieldsExist.passwordExists) {
    throw new Error(
      "Login form not found - no username or password fields detected",
    );
  }

  // Wait for fields to be visible if they exist but aren't visible yet
  if (
    (fieldsExist.usernameExists && !fieldsExist.usernameVisible) ||
    (fieldsExist.passwordExists && !fieldsExist.passwordVisible)
  ) {
    console.log("[Instagram] Waiting for login fields to become visible...");
    await humanDelay(1000, 2000);
  }

  // Type username only if field exists (some modals only show password for saved accounts)
  if (fieldsExist.usernameExists && fieldsExist.usernameVisible) {
    console.log("[Instagram] Typing username...");
    await humanType(page, usernameSelector, username, 120);
    await humanDelay(500, 1000);
  } else {
    console.log(
      "[Instagram] Skipping username (field not present - using saved account)",
    );
  }

  // Type password (should always be present)
  if (fieldsExist.passwordExists && fieldsExist.passwordVisible) {
    console.log("[Instagram] Typing password...");
    await humanType(page, passwordSelector, password, 100);
    await humanDelay(800, 1500);
  } else {
    throw new Error("Password field not visible or not found");
  }

  console.log("[Instagram] Clicking login button...");
  // Find and click login button by text content (more reliable than classes)
  const loginClicked = await page.evaluate(() => {
    const buttons = Array.from(
      document.querySelectorAll('button, div[role="button"]'),
    );
    const loginButton = buttons.find(
      (btn) => btn.textContent.trim().toLowerCase() === "log in",
    );
    if (loginButton) {
      loginButton.click();
      return true;
    }
    return false;
  });

  if (!loginClicked) {
    throw new Error("Login button not found");
  }

  // Wait for navigation after login
  await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 });
  await pageLoadDelay();

  // Dismiss any prompts that appear after login (Save Info, Notifications, etc.)
  console.log("[Instagram] Checking for post-login prompts...");
  await dismissPrompts(page, 3);

  console.log("[Instagram] Login successful!");
  return true;
};

// ═══════════════════════════════════════════════════════════════════════════
// GraphQL-based Instagram Scraper (Alternative Method)
// ═══════════════════════════════════════════════════════════════════════════
// List of domains to skip during deep scan (social platforms, tech giants, etc.)
const SKIP_DOMAINS = [
  "apple.com",
  "youtube.com",
  "google.com",
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "tiktok.com",
  "snapchat.com",
  "pinterest.com",
  "reddit.com",
  "amazon.com",
  "ebay.com",
  "paypal.com",
  "github.com",
  "stackoverflow.com",
  "microsoft.com",
  "zoom.us",
  "discord.com",
  "telegram.org",
  "whatsapp.com",
  "spotify.com",
  "netflix.com",
  "t.co",
  "bit.ly",
  "tinyurl.com",
];

const shouldSkipDomain = (url) => {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase().replace(/^www\\./, "");

    // Check if hostname matches or ends with any skip domain
    return SKIP_DOMAINS.some((domain) => {
      return hostname === domain || hostname.endsWith("." + domain);
    });
  } catch (error) {
    return false;
  }
};

const deepScanExternalUrl = async (externalUrl, options = {}) =>
  queuedDeepScanExternalUrl(externalUrl, options);

const enqueueRelationshipDeepScans = ({
  user_id,
  job_id,
  leads = [],
  label = "Instagram",
}) => {
  if (!DEEP_SCAN_RELATIONSHIP_ENABLED || !leads.length) {
    return;
  }

  const scanTargets = leads
    .map((lead) => ({
      lead_id: lead?._id,
      url: lead?.external_url || lead?.external_urls?.[0] || null,
    }))
    .filter((target) => target.lead_id && target.url);

  if (!scanTargets.length) {
    return;
  }

  enqueueDeepScanBatch({
    user_id,
    job_id,
    lead_ids: scanTargets.map((target) => target.lead_id),
    urls: scanTargets.map((target) => target.url),
  }).catch((error) => {
    console.warn(`[DeepScan] ${label} enqueue failed: ${error.message}`);
  });
};

/*
const scrapeWithApify = async (username) => {
  const apifyToken = process.env.APIFY_API_KEY;
  if (!apifyToken) {
    throw new Error("APIFY_API_KEY not configured in environment variables");
  }

  const client = new ApifyClient({ token: apifyToken });

  console.log(`[Apify] Starting scrape for username: ${username}`);

  const input = {
    usernames: [`https://www.instagram.com/${username}/`],
  };

  try {
    const run = await client.actor(APIFY_INSTAGRAM_PROFILE_ACTOR_ID).call(input);
    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    if (!items || items.length === 0) {
      throw new Error("No data returned from Apify");
    }

    console.log("[Apify] Successfully scraped profile");
    return items[0];
  } catch (error) {
    console.log("[Apify] Error:", error.message);
    throw error;
  }
};

const scrapeWithApifyBulk = async (usernames) => {
  const apifyToken = process.env.APIFY_API_KEY;
  if (!apifyToken) {
    throw new Error("APIFY_API_KEY not configured in environment variables");
  }

  const client = new ApifyClient({ token: apifyToken });

  console.log(
    `[Apify Bulk] Starting bulk scrape for ${usernames.length} usernames`,
  );

  const instagramUrls = usernames.map(
    (username) => `https://www.instagram.com/${username}/`,
  );

  const input = {
    usernames: instagramUrls,
  };

  try {
    const run = await client.actor(APIFY_INSTAGRAM_PROFILE_ACTOR_ID).call(input);
    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    if (!items || items.length === 0) {
      throw new Error("No data returned from Apify bulk scrape");
    }

    console.log(`[Apify Bulk] Successfully scraped ${items.length} profiles`);
    return items;
  } catch (error) {
    console.log("[Apify Bulk] Error:", error.message);
    throw error;
  }
};
*/

// Legacy HTML scraper removed. Use scrapeWithInstagramAPI/scrapeWithInstagramAPIBulk.

// ═══════════════════════════════════════════════════════════════════════════
// Instagram JSON API Scraper (i.instagram.com)
// ═══════════════════════════════════════════════════════════════════════════
const scrapeWithInstagramAPI = async (
  username,
  cookieString = null,
  forcedProxyConfig = null,
  { maxRequestRetries = INSTAGRAM_JSON_RETRIES } = {},
) => {
  const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  // const url = `https://i.instagram.com/api/v1/users/${encodeURIComponent(username)}/usernameinfo`;
  // const url = `https://instagram.com/${encodeURIComponent(username)}/?__a=1&__d=dis`;
  const headers = {
    "User-Agent": "Instagram 219.0.0.12.117 Android",
    "X-IG-App-ID": "936619743392459",
    Accept: "application/json",
  };

  if (cookieString) {
    const csrftoken = cookieString.match(/csrftoken=([^;]+)/)?.[1];
    headers["Cookie"] = cookieString;
    if (csrftoken) headers["X-CSRFToken"] = csrftoken;
  }

  console.log(`[InstagramAPI] Fetching profile for @${username} via CheerioCrawler`);

  const responseData = await fetchJsonWithCheerioCrawler({
    url,
    headers,
    label: `instagram-profile-${username}`,
    forcedProxyConfig,
    maxRequestRetries,
    timeoutSecs: 30,
  });

  const user = responseData?.user ?? responseData?.data?.user ?? null;
  console.log(`[InstagramAPI] Received data for @${username}: ${user ? JSON.stringify(user) : "no user data"}`);
  if (!user)
    throw new Error(
      `No user data returned from Instagram API for @${username}`,
    );

  const bio = user.biography || "";
  const bioEmails = extractEmails(bio);
  const bioPhones = extractPhones(bio);

  if (user.business_email) bioEmails.push(user.business_email);
  if (user.business_phone_number) bioPhones.push(user.business_phone_number);

  // Collect external URLs
  const extUrls = (user.bio_links || []).map((l) => l.url).filter(Boolean);
  if (user.external_url && !extUrls.includes(user.external_url))
    extUrls.unshift(user.external_url);

  // Deep-scan external URLs for additional contacts
  let urlEmails = [];
  let urlPhones = [];
  if (DEEP_SCAN_INLINE_SINGLE_PROFILE && extUrls.length > 0) {
    console.log(
      `[InstagramAPI] @${username}: deep-scanning ${extUrls.length} external URL(s)...`,
    );
    for (const extUrl of extUrls) {
      try {
        const scan = await deepScanExternalUrl(extUrl);
        urlEmails.push(...(scan.emails ?? []));
        urlPhones.push(...(scan.phone_numbers ?? []));
      } catch (scanErr) {
        console.log(
          `[InstagramAPI] Deep-scan failed for ${extUrl}: ${scanErr.message}`,
        );
      }
    }
  }

  const allEmails = uniqueValues([...bioEmails, ...urlEmails]);
  const allPhones = uniqueValues([...bioPhones, ...urlPhones]);

  console.log(
    `[InstagramAPI] @${username} → ${allEmails.length} email(s), ${allPhones.length} phone(s)`,
  );

  return {
    id: user.id ?? null,
    username: user.username ?? username,
    fullName: user.full_name ?? null,
    biography: bio,
    followersCount: user.edge_followed_by?.count ?? null,
    followsCount: user.edge_follow?.count ?? null,
    postsCount: user.edge_owner_to_timeline_media?.count ?? null,
    profilePicUrl: user.profile_pic_url ?? null,
    profilePicUrlHD: user.profile_pic_url_hd ?? null,
    externalUrl: user.external_url ?? null,
    externalUrlShimmed: user.external_url_linkshimmed ?? null,
    externalUrls: extUrls.map((u) => ({ url: u })),
    verified: user.is_verified ?? false,
    private: user.is_private ?? false,
    businessCategoryName: user.business_category_name ?? null,
    emails: allEmails,
    phone_numbers: allPhones,
  };
};

// Bulk version of scrapeWithInstagramAPI
const scrapeWithInstagramAPIBulk = async (
  usernames,
  cookieString = null,
  options = {},
) => {
  const context = {
    jobType: normalizeJobType(options?.context?.jobType || "bulk_profiles"),
    jobId: options?.context?.jobId || null,
    userId: options?.context?.userId || null,
  };

  const enrichment = await enrichProfiles(usernames, {
    context,
    chunkSize: options.chunkSize || 50,
    maxChunkSize: options.maxChunkSize || 50,
    cachedUsernames: options.cachedUsernames,
    budgetUsd: options.budgetUsd,
    allowSingleAsFinalLeftover: Boolean(options.allowSingleAsFinalLeftover),
    onChunkComplete: options.onChunkComplete,
  });

  if (options.returnMeta) {
    return enrichment;
  }

  if (enrichment.stage === "SKIPPED_COST_LIMIT") {
    console.warn(
      `[InstagramAPI Bulk] Skipped due to cost limit (estimated=${enrichment.estimatedCost}, budget=${enrichment.budgetUsd})`,
    );
    return [];
  }

  return enrichment.profiles || [];
};

// ═══════════════════════════════════════════════════════════════════════════
// SteadyAPI Fallback
// ═══════════════════════════════════════════════════════════════════════════
const emitScrapeRealtime = ({
  userId,
  event,
  payload = {},
  label = "Instagram GraphQL",
}) => {
  if (!userId || !event) return;

  try {
    const io = getIO();
    io.to(`user:${userId}`).emit(event, {
      event,
      user_id: userId,
      ...payload,
      ts: Date.now(),
    });
  } catch (wsErr) {
    console.warn(`[${label}] WebSocket emit failed (non-fatal): ${wsErr.message}`);
  }
};

const parseRetryAfterMs = (retryAfterHeader) => {
  if (!retryAfterHeader) return null;

  const seconds = Number(retryAfterHeader);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(retryAfterHeader);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return null;
};

const getProfileDetailRateLimitDelayMs = (error, attempt) => {
  const retryAfterMs = parseRetryAfterMs(
    error?.response?.headers?.["retry-after"],
  );
  const exponentialMs =
    PROFILE_DETAIL_RATE_LIMIT_BACKOFF_BASE_MS *
    2 ** Math.max(0, attempt - 1);
  const cappedMs = Math.min(
    PROFILE_DETAIL_RATE_LIMIT_BACKOFF_MAX_MS,
    Math.max(retryAfterMs || 0, exponentialMs),
  );
  const jitterMs = Math.floor(Math.random() * 10_000);

  return cappedMs + jitterMs;
};

const delayAfterProfileDetailRequest = async () => {
  if (PROFILE_DETAIL_BATCH_DELAY_MAX_MS <= 0) return;
  await humanDelay(
    PROFILE_DETAIL_BATCH_DELAY_MIN_MS,
    PROFILE_DETAIL_BATCH_DELAY_MAX_MS,
  );
};

const mapGraphQLUserWithProfile = (user, profile = null, error = null) => ({
  id: profile?.id || user.id,
  username: profile?.username || user.username,
  followers: profile?.followersCount ?? null,
  following: profile?.followsCount ?? null,
  bio: profile?.biography || null,
  category: profile?.businessCategoryName || null,
  avatar: profile?.profilePicUrlHD || profile?.profilePicUrl || user.profile_pic_url,
  full_name: profile?.fullName || user.full_name || null,
  is_verified: profile?.verified ?? user.is_verified ?? false,
  is_private: profile?.private ?? user.is_private ?? false,
  external_url: profile?.externalUrl || null,
  posts_count: profile?.postsCount ?? null,
  emails: uniqueValues(profile?.emails || []),
  phone_numbers: uniqueValues(profile?.phone_numbers || []),
  ...(error ? { error: error.message } : {}),
});

const buildInstagramRelationshipLeadPayload = ({
  user,
  type,
  targetUsername,
  scrapingMethod = "GraphQL API",
}) => {
  const { first_name, last_name } = splitName(user.full_name || "");

  return {
    first_name,
    last_name,
    company: user.username || "",
    emails: user.emails || [],
    phone_numbers: user.phone_numbers || [],
    message: `
${relationshipScrapeTitle(type)} (${scrapingMethod})

Target Profile: @${targetUsername}
Username: @${user.username || "N/A"}
Full Name: ${user.full_name || "N/A"}
Bio: ${user.bio || "N/A"}
Followers: ${user.followers || "N/A"}
Following: ${user.following || "N/A"}
Posts: ${user.posts_count || "N/A"}
Verified: ${user.is_verified ? "Yes" : "No"}
Private: ${user.is_private ? "Yes" : "No"}
Category: ${user.category || "N/A"}
Profile URL: https://www.instagram.com/${user.username}
Scraping Method: ${scrapingMethod}
${user.emails && user.emails.length > 0 ? `Emails: ${user.emails.join(", ")}` : ""}
${user.phone_numbers && user.phone_numbers.length > 0 ? `Phone Numbers: ${user.phone_numbers.join(", ")}` : ""}
    `.trim(),
    scraped_from_username: targetUsername,
    relationship_type: toRelationshipDirection(type),
    source_url: `https://www.instagram.com/${user.username}`,
    source_rul: `https://www.instagram.com/${user.username}`,
    instagram_profile_id: user.id !== user.username ? user.id : null,
    username: user.username,
    full_name: user.full_name,
    bio: user.bio,
    avatar_url: user.avatar,
    avatar_rul: user.avatar,
    followers: user.followers,
    following: user.following,
    follower_count: user.followers,
    following_count: user.following,
    total_posts: user.posts_count,
    category: user.category,
    external_url: user.external_url,
    external_url_linkshimmed: null,
    external_urls: user.external_url ? [user.external_url] : [],
    is_private: user.is_private,
    is_verified: user.is_verified,
    is_public: user.is_private !== null ? !user.is_private : null,
    fb_profile_biolink: null,
    highlight_reel_count: null,
    links: [],
    scrape_status: true,
    type: "INSTAGRAM",
  };
};

const fetchProfileDetailWithAdaptiveBackoff = async ({
  user,
  cookieString,
  sessionProxyConfig,
  batchNumber,
}) => {
  for (let attempt = 1; attempt <= PROFILE_DETAIL_RATE_LIMIT_MAX_ATTEMPTS; attempt++) {
    try {
      const profile = await scrapeWithInstagramAPI(
        user.username,
        cookieString,
        sessionProxyConfig,
        { maxRequestRetries: 0 },
      );
      return mapGraphQLUserWithProfile(user, profile);
    } catch (error) {
      if (isRateLimitError(error)) {
        if (attempt >= PROFILE_DETAIL_RATE_LIMIT_MAX_ATTEMPTS) {
          console.warn(
            `[Instagram GraphQL] Batch #${batchNumber}: web_profile_info still rate-limited for @${user.username} after ${attempt} attempt(s)`,
          );
          throw error;
        }

        const waitMs = getProfileDetailRateLimitDelayMs(error, attempt);
        console.warn(
          `[Instagram GraphQL] Batch #${batchNumber}: 429 while fetching @${user.username}; waiting ${Math.round(waitMs / 1000)}s before retry ${attempt + 1}/${PROFILE_DETAIL_RATE_LIMIT_MAX_ATTEMPTS}`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      if (isAuthError(error)) {
        throw error;
      }

      console.warn(
        `[Instagram GraphQL] web_profile_info failed for @${user.username}; using GraphQL fallback: ${error.message}`,
      );
      return mapGraphQLUserWithProfile(user, null, error);
    }
  }

  return mapGraphQLUserWithProfile(user, null);
};

const enrichGraphQLBatchWithInstagramAPI = async ({
  users,
  cookieString,
  sessionProxyConfig,
  batchNumber,
  relationshipType,
  jobId,
  userId,
  processedCountBeforeBatch = 0,
}) => {
  const enrichedUsers = [];
  const startedAt = Date.now();
  let chunksProcessedInBatch = 0;

  const queryName =
    relationshipType === "following"
      ? "edge_follow"
      : "edge_followed_by";

  console.log(
    JSON.stringify({
      event: "instagram_query_batch_started",
      job_id: jobId || null,
      query_name: queryName,
      batch_number: batchNumber,
      result_count: users.length,
      total_count: null,
    }),
  );

  const usernameList = users.map((user) => user.username).filter(Boolean);
  const apifyResult = await scrapeWithInstagramAPIBulk(usernameList, cookieString, {
    context: {
      jobType: relationshipType === "following" ? "following" : "followers",
      jobId,
      userId,
    },
    // Hard enforce 50-sized chunks for relationship enrichment.
    chunkSize: 50,
    maxChunkSize: 50,
    allowSingleAsFinalLeftover: processedCountBeforeBatch > 0,
    returnMeta: true,
    onChunkComplete: ({ chunkIndex, inputCount, outputCount, metricsSnapshot }) => {
      chunksProcessedInBatch += 1;
      emitScrapeRealtime({
        userId,
        event: "scrape:enrichment_chunk",
        payload: {
          job_id: jobId || null,
          type: relationshipType,
          batch_number: batchNumber,
          chunk_index: chunkIndex,
          chunk_input_count: inputCount,
          chunk_output_count: outputCount,
          chunks_processed_in_batch: chunksProcessedInBatch,
          ...metricsSnapshot,
        },
      });
    },
  });

  const profileMap = apifyResult.profileByUsername || new Map();

  for (const user of users) {
    const profile = profileMap.get(String(user.username || "").toLowerCase()) || null;
    enrichedUsers.push(mapGraphQLUserWithProfile(user, profile));
  }

  if (apifyResult.stage === "SKIPPED_COST_LIMIT") {
    console.warn(
      `[Instagram GraphQL] Skipping Apify enrichment due to cost limit (estimated=${apifyResult.estimatedCost}, budget=${apifyResult.budgetUsd})`,
    );
  }

  console.log(
    JSON.stringify({
      event: "instagram_query_batch_finished",
      job_id: jobId || null,
      query_name: queryName,
      result_count: enrichedUsers.length,
      total_count: null,
      elapsed_ms: Date.now() - startedAt,
      apify_metrics: apifyResult.metrics,
      enrichment_stage: apifyResult.stage,
    }),
  );

  return enrichedUsers;
};

const saveInstagramRelationshipBatch = async ({
  enrichedUsers,
  user_id,
  folder_id,
  targetUsername,
  type,
  jobId = null,
}) => {
  if (!enrichedUsers.length) {
    return {
      insertedLeads: [],
      cachedCount: 0,
      newCount: 0,
      linkedCount: 0,
    };
  }

  let reservedCredits = 0;
  const leadsToInsert = enrichedUsers.map((user) =>
    buildInstagramRelationshipLeadPayload({
      user,
      type,
      targetUsername,
      scrapingMethod: "GraphQL API + web_profile_info",
    }),
  );

  try {
    reservedCredits = await reserveScrapedProfileCredits(
      user_id,
      leadsToInsert.length,
    );

    const bulkResult = await userLeadService.bulkResolveOrCreate(
      leadsToInsert,
      {
        user_id,
        folder_id,
        type: "INSTAGRAM",
        scraped_from_username: targetUsername,
        relationship_type: toRelationshipDirection(type),
      },
    );

    await refundUnusedScrapedProfileCredits(
      user_id,
      reservedCredits,
      bulkResult.insertedLeads.length,
    );
    enqueueRelationshipDeepScans({
      user_id,
      job_id: jobId,
      leads: bulkResult.insertedLeads,
      label: "Instagram GraphQL",
    });
    console.log(
      `[Instagram] Done — new: ${bulkResult.newCount}, from cache: ${bulkResult.cachedCount}`,
    );
    return {
      insertedLeads: bulkResult.insertedLeads,
      cachedCount: bulkResult.cachedCount,
      newCount: bulkResult.newCount,
      linkedCount: bulkResult.userLeads?.insertedCount || 0,
    };
  } catch (error) {
    await refundUnusedScrapedProfileCredits(user_id, reservedCredits, 0);
    throw error;
  }
};

const scrapeWithSteadyAPI = async (username) => {
  console.log(`[SteadyAPI] Fallback scrape for username: ${username}`);

  try {
    const response = await axios.get(
      `https://api.steadyapi.com/v1/instagram/profile?username=${username}`,
      {
        timeout: 30000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      },
    );

    if (!response.data?.body) {
      throw new Error("Invalid response from SteadyAPI");
    }

    console.log("[SteadyAPI] Successfully scraped profile");
    return response.data.body;
  } catch (error) {
    console.log("[SteadyAPI] Error:", error.message);
    throw error;
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Transform Apify Response to Lead Format
// ═══════════════════════════════════════════════════════════════════════════
const transformApifyToLead = (apifyData) => {
  const { first_name, last_name } = splitName(apifyData.fullName);

  // Extract emails and phones from bio
  const bioEmails = extractEmails(apifyData.biography || "");
  const bioPhones = extractPhones(apifyData.biography || "");

  // Extract external URLs
  const externalUrls = uniqueValues(
    [
      apifyData.externalUrl,
      ...(Array.isArray(apifyData.externalUrls)
        ? apifyData.externalUrls.map((link) => link.url).filter(Boolean)
        : []),
    ].filter(Boolean),
  );

  // Build profile data structure
  const profileData = {
    instagram_profile_id: apifyData.id || null,
    username: apifyData.username || null,
    full_name: apifyData.fullName || null,
    bio: apifyData.biography || null,
    avatar_url: apifyData.profilePicUrlHD || apifyData.profilePicUrl || null,
    followers: parseCount(apifyData.followersCount),
    following: parseCount(apifyData.followsCount),
    total_posts: parseCount(apifyData.postsCount),
    category: apifyData.businessCategoryName || null,
    external_url: apifyData.externalUrl || null,
    external_url_linkshimmed: apifyData.externalUrlShimmed || null,
    external_urls: externalUrls,
    is_private: apifyData.private ?? null,
    is_verified: apifyData.verified ?? null,
    is_public: apifyData.private !== null ? !apifyData.private : null,
    highlight_reel_count: parseCount(apifyData.highlightReelCount),
    links: Array.isArray(apifyData.externalUrls) ? apifyData.externalUrls : [],
    source_url:
      apifyData.url || `https://www.instagram.com/${apifyData.username}`,
  };

  return {
    profileData,
    first_name,
    last_name,
    bioEmails,
    bioPhones,
    externalUrls,
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// Transform SteadyAPI Response to Lead Format
// ═══════════════════════════════════════════════════════════════════════════
const transformSteadyAPIToLead = (steadyData) => {
  const { first_name, last_name } = splitName(steadyData.full_name);

  const bioEmails = extractEmails(steadyData.biography || "");
  const bioPhones = extractPhones(steadyData.biography || "");

  const externalUrls = uniqueValues(
    [
      steadyData.external_url,
      ...(Array.isArray(steadyData.bio_links)
        ? steadyData.bio_links.map((link) => link.url).filter(Boolean)
        : []),
    ].filter(Boolean),
  );

  const profileData = {
    instagram_profile_id: steadyData.id || null,
    username: steadyData.username || null,
    full_name: steadyData.full_name || null,
    bio: steadyData.biography || null,
    avatar_url: steadyData.profile_pic_hd || steadyData.profile_pic || null,
    followers: parseCount(steadyData.followers),
    following: parseCount(steadyData.following),
    total_posts: parseCount(steadyData.posts),
    category: steadyData.category || null,
    external_url: steadyData.external_url || null,
    external_url_linkshimmed: null,
    external_urls: externalUrls,
    is_private: steadyData.is_private ?? null,
    is_verified: steadyData.is_verified ?? null,
    is_public: steadyData.is_private !== null ? !steadyData.is_private : null,
    highlight_reel_count: parseCount(steadyData.highlight_reel_count),
    links: Array.isArray(steadyData.bio_links) ? steadyData.bio_links : [],
    source_url:
      steadyData.profile_url ||
      `https://www.instagram.com/${steadyData.username}`,
  };

  return {
    profileData,
    first_name,
    last_name,
    bioEmails,
    bioPhones,
    externalUrls,
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// Main Function: Scrape Instagram Profile
// ═══════════════════════════════════════════════════════════════════════════
const scrapeInstagram = async ({ profileUrl, user_id, folder_id }) => {
  if (!profileUrl) {
    return {
      code: 400,
      success: false,
      message: "instagram-profile-url-is-required",
    };
  }

  // Extract username from URL
  let username;
  try {
    const url = new URL(profileUrl);
    username = url.pathname.split("/").filter(Boolean)[0];
    if (!username) {
      throw new Error("Invalid Instagram URL");
    }
  } catch (error) {
    return {
      code: 400,
      success: false,
      message: "invalid-instagram-url",
      error: error.message,
    };
  }

  let profileData;
  let first_name, last_name, bioEmails, bioPhones, externalUrls;
  let scrapedWith = "instagram-api";

  // Try Instagram API first
  try {
    const apifyData = await scrapeWithInstagramAPI(username);
    const transformed = transformApifyToLead(apifyData);
    profileData = transformed.profileData;
    first_name = transformed.first_name;
    last_name = transformed.last_name;
    bioEmails = transformed.bioEmails;
    bioPhones = transformed.bioPhones;
    externalUrls = transformed.externalUrls;
  } catch (apifyError) {
    console.log("[Main] Instagram API failed, trying SteadyAPI fallback");

    // Fallback to SteadyAPI
    try {
      const steadyData = await scrapeWithSteadyAPI(username);
      const transformed = transformSteadyAPIToLead(steadyData);
      profileData = transformed.profileData;
      first_name = transformed.first_name;
      last_name = transformed.last_name;
      bioEmails = transformed.bioEmails;
      bioPhones = transformed.bioPhones;
      externalUrls = transformed.externalUrls;
      scrapedWith = "steadyapi";
    } catch (steadyError) {
      console.log("[Main] Both Apify and SteadyAPI failed");
      return {
        code: 500,
        success: false,
        message: "failed-to-scrape-instagram-profile",
        errors: {
          apify: apifyError.message,
          steadyapi: steadyError.message,
        },
      };
    }
  }

  // Perform deep scan on external URLs
  let deepScanResults = [];
  let allEmails = [...bioEmails];
  let allPhones = [...bioPhones];
  let skippedCount = 0;

  if (DEEP_SCAN_INLINE_SINGLE_PROFILE && externalUrls.length > 0) {
    console.log(`[Main] Starting deep scan for ${externalUrls.length} URLs`);

    for (const url of externalUrls) {
      const scanResult = await deepScanExternalUrl(url);

      if (scanResult.skipped) {
        skippedCount++;
      }

      deepScanResults.push(scanResult);

      if (scanResult.emails.length > 0) {
        allEmails.push(...scanResult.emails);
      }
      if (scanResult.phone_numbers.length > 0) {
        allPhones.push(...scanResult.phone_numbers);
      }

      // Small delay between requests
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    console.log(
      `[Main] Deep scan completed. Scanned: ${externalUrls.length - skippedCount}, Skipped: ${skippedCount}`,
    );
  }

  // Unique values
  allEmails = uniqueValues(allEmails);
  allPhones = uniqueValues(allPhones);

  // Create or reuse Lead + link via UserLead (dedup-aware)
  try {
    const leadPayload = {
      first_name,
      last_name,
      company: profileData.username || "",
      emails: allEmails,
      phone_numbers: allPhones,
      message: `
Instagram Profile Scraped

Username: ${profileData.username || "N/A"}
Full Name: ${profileData.full_name || "N/A"}
Bio: ${profileData.bio || "N/A"}
Followers: ${profileData.followers || "N/A"}
Following: ${profileData.following || "N/A"}
Profile URL: ${profileData.source_url}
Scraped with: ${scrapedWith.toUpperCase()}
      `.trim(),
      source_url: profileData.source_url,
      source_rul: profileData.source_url,
      instagram_profile_id: profileData.instagram_profile_id,
      username: profileData.username,
      full_name: profileData.full_name,
      bio: profileData.bio,
      avatar_url: profileData.avatar_url,
      avatar_rul: profileData.avatar_url,
      followers: profileData.followers,
      following: profileData.following,
      follower_count: profileData.followers,
      following_count: profileData.following,
      total_posts: profileData.total_posts,
      category: profileData.category,
      external_url: profileData.external_url,
      external_url_linkshimmed: profileData.external_url_linkshimmed,
      external_urls: profileData.external_urls,
      is_private: profileData.is_private,
      is_verified: profileData.is_verified,
      is_public: profileData.is_public,
      fb_profile_biolink: null,
      highlight_reel_count: null,
      links: profileData.links,
      scrape_status: true,
      type: "INSTAGRAM",
    };

    const { lead, fromCache } = await userLeadService.resolveOrCreateLead(
      leadPayload,
      { user_id, folder_id, type: "INSTAGRAM" },
    );

    if (!DEEP_SCAN_INLINE_SINGLE_PROFILE && externalUrls.length > 0) {
      enqueueDeepScanBatch({
        user_id,
        lead_ids: externalUrls.map(() => lead?._id),
        urls: externalUrls,
        job_id: null,
      }).catch((error) => {
        console.warn(
          `[DeepScan] enqueue failed for @${profileData.username}: ${error.message}`,
        );
      });
    }

    return {
      code: 200,
      success: true,
      message: fromCache
        ? "instagram-profile-fetched-from-cache"
        : "instagram-profile-scraped-successfully",
      scraped_with: scrapedWith,
      from_cache: fromCache,
      data: {
        lead,
        profile: profileData,
        deep_scan: {
          scanned_urls: deepScanResults.length,
          results: deepScanResults,
          total_emails_found: allEmails.length,
          total_phones_found: allPhones.length,
        },
      },
    };
  } catch (dbError) {
    console.error("[Main] Database error:", dbError);
    return {
      code: 500,
      success: false,
      message: "failed-to-save-lead-to-database",
      error: dbError.message,
    };
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Bulk Instagram Profile Scraper
// ═══════════════════════════════════════════════════════════════════════════
const scrapeInstagramBulk = async ({ profileUrls, user_id, folder_id }) => {
  if (!profileUrls || !Array.isArray(profileUrls) || profileUrls.length === 0) {
    return {
      code: 400,
      success: false,
      message: "profileUrls array is required and cannot be empty",
    };
  }

  console.log(`[Bulk] Starting bulk scrape for ${profileUrls.length} profiles`);

  // Extract all usernames from profile URLs
  const usernames = [];
  const usernameToUrlMap = new Map();

  for (const profileUrl of profileUrls) {
    const username = profileUrl
      .replace(/https?:\/\/(www\.)?instagram\.com\//gi, "")
      .replace(/\/$/, "")
      .trim();

    if (username) {
      usernames.push(username);
      usernameToUrlMap.set(username.toLowerCase(), profileUrl);
    }
  }

  if (usernames.length === 0) {
    return {
      code: 400,
      success: false,
      message: "No valid usernames found in profileUrls",
    };
  }

  console.log(`[Bulk] Extracted ${usernames.length} valid usernames`);

  const results = [];
  const leadsToInsert = [];
  let successCount = 0;
  let failCount = 0;

  try {
    // Fetch profiles via Instagram API
    console.log(
      `[Bulk] Sending request to Instagram API for ${usernames.length} profiles...`,
    );
    const apifyBulkData = await scrapeWithInstagramAPIBulk(usernames, null, {
      context: {
        jobType: "bulk_profiles",
        userId: user_id || null,
      },
    });

    // Process each result from Apify
    for (const apifyData of apifyBulkData) {
      try {
        const transformed = transformApifyToLead(apifyData);
        const {
          profileData,
          first_name,
          last_name,
          bioEmails,
          bioPhones,
          externalUrls,
        } = transformed;

        // Unique values
        const allEmails = uniqueValues(bioEmails);
        const allPhones = uniqueValues(bioPhones);

        // Get original profile URL
        const originalUrl =
          usernameToUrlMap.get(profileData.username?.toLowerCase()) ||
          profileData.source_url;

        // Prepare lead data for bulk insert
        const leadData = {
          first_name,
          last_name,
          company: profileData.username || "",
          emails: allEmails,
          phone_numbers: allPhones,
          message: `
Instagram Profile Scraped (Bulk)

Username: ${profileData.username || "N/A"}
Full Name: ${profileData.full_name || "N/A"}
Bio: ${profileData.bio || "N/A"}
Followers: ${profileData.followers || "N/A"}
Following: ${profileData.following || "N/A"}
Profile URL: ${profileData.source_url}
Scraped with: APIFY
          `.trim(),
          source_url: profileData.source_url,
          source_rul: profileData.source_url,
          instagram_profile_id: profileData.instagram_profile_id,
          username: profileData.username,
          full_name: profileData.full_name,
          bio: profileData.bio,
          avatar_url: profileData.avatar_url,
          avatar_rul: profileData.avatar_url,
          followers: profileData.followers,
          following: profileData.following,
          follower_count: profileData.followers,
          following_count: profileData.following,
          total_posts: profileData.total_posts,
          category: profileData.category,
          external_url: profileData.external_url,
          external_url_linkshimmed: null,
          external_urls: profileData.external_urls,
          is_private: profileData.is_private,
          is_verified: profileData.is_verified,
          is_public: profileData.is_public,
          fb_profile_biolink: null,
          highlight_reel_count: null,
          links: profileData.links,
          scrape_status: true,
          type: "INSTAGRAM",
        };

        leadsToInsert.push(leadData);

        results.push({
          profileUrl: originalUrl,
          username: profileData.username,
          success: true,
          scraped_with: "apify",
          profile: profileData,
        });

        successCount++;
      } catch (transformError) {
        console.error(
          `[Bulk] Error transforming profile data:`,
          transformError.message,
        );
        results.push({
          profileUrl: apifyData.url || "unknown",
          username: apifyData.username || "unknown",
          success: false,
          error: transformError.message,
        });
        failCount++;
      }
    }

    console.log(
      `[Bulk] Processed ${successCount} profiles successfully, ${failCount} failed`,
    );
  } catch (apifyError) {
    console.error(`[Bulk] Apify bulk scrape failed:`, apifyError.message);

    // If bulk Apify fails, mark all as failed
    for (const username of usernames) {
      results.push({
        profileUrl: usernameToUrlMap.get(username.toLowerCase()),
        username: username,
        success: false,
        error: apifyError.message,
      });
      failCount++;
    }
  }

  // Bulk insert all leads into MongoDB
  let insertedLeads = [];
  if (leadsToInsert.length > 0) {
    try {
      console.log(
        `[Bulk] Inserting ${leadsToInsert.length} leads into database...`,
      );
      insertedLeads = await Lead.insertMany(leadsToInsert, { ordered: false });
      console.log(`[Bulk] Successfully inserted ${insertedLeads.length} leads`);
    } catch (dbError) {
      console.error("[Bulk] Database bulk insert error:", dbError.message);
      // Even if some fail, insertMany with ordered:false will continue
      // Check if any were inserted
      if (dbError.insertedDocs) {
        insertedLeads = dbError.insertedDocs;
      }
    }
  }

  return {
    code: 200,
    success: true,
    message: "bulk-instagram-scraping-completed",
    data: {
      total: profileUrls.length,
      success: successCount,
      failed: failCount,
      leads_inserted: insertedLeads.length,
      results: results,
      leads: insertedLeads,
    },
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// Instagram Browser Automation - Followers/Following Scraper
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════

const activeRelationshipLocks = new Map();

const buildRelationshipLockKey = ({ jobId, userId, targetUsername, type }) => {
  if (jobId) return `instagram:scrape:${jobId}`;
  return [
    "instagram:relationship",
    userId || "anonymous",
    String(targetUsername || "").trim().toLowerCase() || "unknown-target",
    normalizeRelationshipRequestType(type),
  ].join(":");
};

const acquireRelationshipLock = (context) => {
  const lockKey = buildRelationshipLockKey(context);
  if (activeRelationshipLocks.has(lockKey)) {
    return { acquired: false, lockKey };
  }

  activeRelationshipLocks.set(lockKey, {
    ...context,
    acquiredAt: Date.now(),
  });

  return { acquired: true, lockKey };
};

const releaseRelationshipLock = (lockKey) => {
  if (lockKey) activeRelationshipLocks.delete(lockKey);
};

// ═══════════════════════════════════════════════════════════════════════════
// RESOURCE LIMITS - Safe limits for EC2 micro (1GB RAM)
// ═══════════════════════════════════════════════════════════════════════════
const SAFE_SCRAPE_LIMIT = 300; // Max users to scrape per session (memory safe)
const ENRICH_LIMIT = 100; // Max users to enrich with Apify (API safe)

// Human-like delay helper
const humanDelay = (min = 1000, max = 3000) => {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, delay));
};

// Longer delay for page loads
const pageLoadDelay = () => humanDelay(2000, 4000);

// Gentle scroll delay
const scrollDelay = () => humanDelay(800, 1500);

// Type like a human
const humanType = async (page, selector, text, delayBetweenKeys = 100) => {
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

// Save cookies to file
// Save cookies to file
const saveCookies = async (page, filepath) => {
  const cookies = await page.cookies();

  // Ensure directory exists
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[Instagram] Created directory: ${dir}`);
  }

  fs.writeFileSync(filepath, JSON.stringify(cookies, null, 2));
  console.log(`[Instagram] Cookies saved to ${filepath}`);
};

// Load cookies from file
const loadCookies = async (page, filepath) => {
  if (fs.existsSync(filepath)) {
    const cookies = JSON.parse(fs.readFileSync(filepath, "utf-8"));
    await page.setCookie(...cookies);
    console.log(`[Instagram] Cookies loaded from ${filepath}`);
    return true;
  }
  return false;
};

// Check if logged in
const isLoggedIn = async (page) => {
  try {
    // Wait a bit for page to settle
    await humanDelay(1500, 2500);

    console.log("[Instagram] Running login detection checks...");

    // PRIORITY 1: Positive check - Look for elements that only appear when logged in
    const loggedInIndicator = await page.evaluate(() => {
      // Check for nav bar elements (home, search, etc.)
      const nav = document.querySelector("nav");
      if (nav) {
        // Look for home link or user menu or svg icons (indicating logged-in nav)
        const hasHomeLink = nav.querySelector('a[href="/"]');
        const hasSvg = nav.querySelector("svg");
        const hasProfileLink = nav.textContent
          .toLowerCase()
          .includes("profile");

        if ((hasHomeLink && hasSvg) || hasProfileLink) {
          console.log("[Instagram Check] Found logged-in navigation elements");
          return true;
        }
      }

      // Check for search bar or create post elements
      const hasSearchOrCreate =
        document.querySelector('input[placeholder*="Search"]') ||
        document.querySelector('[aria-label*="New post"]') ||
        document.querySelector('[aria-label*="Create"]');
      if (hasSearchOrCreate) {
        console.log("[Instagram Check] Found search/create elements");
        return true;
      }

      return false;
    });

    if (loggedInIndicator) {
      console.log(
        "[Instagram] ✓ Detected logged-in state (positive indicators)",
      );
      return true;
    }

    // PRIORITY 2: Check for login page URL
    const currentUrl = page.url();
    if (currentUrl.includes("/accounts/login")) {
      console.log("[Instagram] ✗ On login page - not logged in");
      return false;
    }

    // PRIORITY 3: Check for "Log in" dialog/modal (appears on profile pages when not logged in)
    const loginDialog = await page.evaluate(() => {
      const dialogs = document.querySelectorAll('div[role="dialog"]');
      for (const dialog of dialogs) {
        if (
          dialog.textContent.includes("Log in") ||
          dialog.textContent.includes("Sign up for Instagram")
        ) {
          console.log("[Instagram Check] Found login dialog");
          return true;
        }
      }
      return false;
    });

    if (loginDialog) {
      console.log("[Instagram] ✗ Detected login dialog - not logged in");
      return false;
    }

    // PRIORITY 4: Check for login form inputs (last resort)
    const emailInput = await page.$('input[name="email"]');
    const usernameInput = await page.$('input[name="username"]');
    const passwordInput = await page.$(
      'input[name="pass"], input[name="password"]',
    );

    if ((emailInput || usernameInput) && passwordInput) {
      console.log("[Instagram] ✗ Detected login form - not logged in");
      return false;
    }

    // If we reach here and found no negative indicators, assume logged in
    console.log("[Instagram] ✓ No login indicators found - assuming logged in");
    return true;
  } catch (error) {
    console.log("[Instagram] Error checking login status:", error.message);
    return false;
  }
};

// Dismiss Instagram prompts/dialogs (Save Login Info, Notifications, etc.)
const dismissPrompts = async (page, maxAttempts = 3) => {
  for (let i = 0; i < maxAttempts; i++) {
    await humanDelay(1000, 2000);

    const dismissed = await page.evaluate(() => {
      // Find "Not Now" buttons
      const elements = Array.from(
        document.querySelectorAll('button, div[role="button"]'),
      );
      const notNowButton = elements.find((el) => {
        const text = el.textContent.trim().toLowerCase();
        return text === "not now";
      });

      if (notNowButton) {
        const parentText = notNowButton.closest("div")?.textContent || "";
        console.log(
          `[Instagram Check] Found "Not Now" button in context: ${parentText.substring(0, 50)}...`,
        );
        notNowButton.click();
        return true;
      }

      return false;
    });

    if (dismissed) {
      console.log(`[Instagram] Dismissed prompt (attempt ${i + 1})`);
      await humanDelay(1000, 2000);
    } else {
      // No more prompts found
      console.log(`[Instagram] No more prompts to dismiss (attempt ${i + 1})`);
      break;
    }
  }
};

// Login to Instagram
const loginToInstagram = async (page) => {
  const username = process.env.INSTAGRAM_USERNAME;
  const password = process.env.INSTAGRAM_PASSWORD;
  const usernameSelector =
    process.env.INSTAGRAM_USERNAME_SELECTOR || 'input[name="username"]';
  const passwordSelector =
    process.env.INSTAGRAM_PASSWORD_SELECTOR || 'input[name="password"]';

  if (!username || !password) {
    throw new Error(
      "Instagram credentials not configured in environment variables",
    );
  }

  console.log("[Instagram] Navigating to login page...");
  await page.goto("https://www.instagram.com/accounts/login/", {
    waitUntil: "networkidle2",
    timeout: 30000,
  });

  await pageLoadDelay();

  // Give extra time for account selection screen to fully render
  await humanDelay(1500, 2500);

  // Check for account selection screen and click "Use another profile"
  console.log("[Instagram] Checking for account selection screen...");

  // Try to wait for the "Use another profile" button (up to 5 seconds)
  let useAnotherProfileClicked = false;
  try {
    await page.waitForSelector(
      '[aria-label="Use another profile"][role="button"]',
      {
        timeout: 5000,
        visible: true,
      },
    );
    console.log(
      '[Instagram] "Use another profile" button detected, clicking...',
    );

    useAnotherProfileClicked = await page.evaluate(() => {
      const useAnotherBtn = document.querySelector(
        '[aria-label="Use another profile"][role="button"]',
      );
      if (useAnotherBtn) {
        console.log('[Instagram] Clicking "Use another profile" button...');
        useAnotherBtn.click();
        return true;
      }
      return false;
    });
  } catch (error) {
    console.log(
      '[Instagram] "Use another profile" button not found within timeout, checking manually...',
    );

    // Fallback: manual search
    useAnotherProfileClicked = await page.evaluate(() => {
      const allButtons = Array.from(
        document.querySelectorAll('[role="button"]'),
      );
      console.log(
        `[Instagram] Manually checking ${allButtons.length} buttons...`,
      );

      for (const btn of allButtons) {
        const btnText = btn.textContent.trim();
        const ariaLabel = btn.getAttribute("aria-label");

        if (
          btnText.includes("Use another profile") ||
          btnText.includes("use another profile") ||
          ariaLabel?.includes("Use another profile")
        ) {
          console.log(`[Instagram] Found match, clicking...`);
          btn.click();
          return true;
        }
      }
      return false;
    });
  }

  if (useAnotherProfileClicked) {
    console.log(
      "[Instagram] Clicked 'Use another profile', waiting for login form...",
    );
    await humanDelay(2000, 3000);
  } else {
    console.log(
      "[Instagram] 'Use another profile' button not found, checking if login form is already visible...",
    );
    await humanDelay(1000, 1500);
  }

  // Check if username and password fields exist
  console.log("[Instagram] Checking for login form fields...");
  const fieldsExist = await page.evaluate(
    (usernameSelector, passwordSelector) => {
      const usernameField = document.querySelector(usernameSelector);
      const passwordField = document.querySelector(passwordSelector);
      return {
        usernameExists: !!usernameField,
        passwordExists: !!passwordField,
        usernameVisible: usernameField && usernameField.offsetParent !== null,
        passwordVisible: passwordField && passwordField.offsetParent !== null,
      };
    },
    usernameSelector,
    passwordSelector,
  );

  console.log(`[Instagram] Login fields status:`, fieldsExist);

  // If neither field exists, throw error
  if (!fieldsExist.usernameExists && !fieldsExist.passwordExists) {
    throw new Error(
      "Login form not found - no username or password fields detected",
    );
  }

  // Wait for fields to be visible if they exist but aren't visible yet
  if (
    (fieldsExist.usernameExists && !fieldsExist.usernameVisible) ||
    (fieldsExist.passwordExists && !fieldsExist.passwordVisible)
  ) {
    console.log("[Instagram] Waiting for login fields to become visible...");
    await humanDelay(1000, 2000);
  }

  // Type username only if field exists (some modals only show password for saved accounts)
  if (fieldsExist.usernameExists && fieldsExist.usernameVisible) {
    console.log("[Instagram] Typing username...");
    await humanType(page, usernameSelector, username, 120);
    await humanDelay(500, 1000);
  } else {
    console.log(
      "[Instagram] Skipping username (field not present - using saved account)",
    );
  }

  // Type password (should always be present)
  if (fieldsExist.passwordExists && fieldsExist.passwordVisible) {
    console.log("[Instagram] Typing password...");
    await humanType(page, passwordSelector, password, 100);
    await humanDelay(800, 1500);
  } else {
    throw new Error("Password field not visible or not found");
  }

  console.log("[Instagram] Clicking login button...");
  // Find and click login button by text content (more reliable than classes)
  const loginClicked = await page.evaluate(() => {
    const buttons = Array.from(
      document.querySelectorAll('button, div[role="button"]'),
    );
    const loginButton = buttons.find(
      (btn) => btn.textContent.trim().toLowerCase() === "log in",
    );
    if (loginButton) {
      loginButton.click();
      return true;
    }
    return false;
  });

  if (!loginClicked) {
    throw new Error("Login button not found");
  }

  // Wait for navigation after login
  await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 });
  await pageLoadDelay();

  // Dismiss any prompts that appear after login (Save Info, Notifications, etc.)
  console.log("[Instagram] Checking for post-login prompts...");
  await dismissPrompts(page, 3);

  console.log("[Instagram] Login successful!");
  return true;
};

// ═══════════════════════════════════════════════════════════════════════════
// GraphQL-based Instagram Scraper (Alternative Method)
// ═══════════════════════════════════════════════════════════════════════════
// List of domains to skip during deep scan (social platforms, tech giants, etc.)
const SKIP_DOMAINS = [
  "apple.com",
  "youtube.com",
  "google.com",
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "tiktok.com",
  "snapchat.com",
  "pinterest.com",
  "reddit.com",
  "amazon.com",
  "ebay.com",
  "paypal.com",
  "github.com",
  "stackoverflow.com",
  "microsoft.com",
  "zoom.us",
  "discord.com",
  "telegram.org",
  "whatsapp.com",
  "spotify.com",
  "netflix.com",
  "t.co",
  "bit.ly",
  "tinyurl.com",
];

const shouldSkipDomain = (url) => {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase().replace(/^www\\./, "");

    // Check if hostname matches or ends with any skip domain
    return SKIP_DOMAINS.some((domain) => {
      return hostname === domain || hostname.endsWith("." + domain);
    });
  } catch (error) {
    return false;
  }
};

const deepScanExternalUrl = async (externalUrl, options = {}) =>
  queuedDeepScanExternalUrl(externalUrl, options);

const enqueueRelationshipDeepScans = ({
  user_id,
  job_id,
  leads = [],
  label = "Instagram",
}) => {
  if (!DEEP_SCAN_RELATIONSHIP_ENABLED || !leads.length) {
    return;
  }

  const scanTargets = leads
    .map((lead) => ({
      lead_id: lead?._id,
      url: lead?.external_url || lead?.external_urls?.[0] || null,
    }))
    .filter((target) => target.lead_id && target.url);

  if (!scanTargets.length) {
    return;
  }

  enqueueDeepScanBatch({
    user_id,
    job_id,
    lead_ids: scanTargets.map((target) => target.lead_id),
    urls: scanTargets.map((target) => target.url),
  }).catch((error) => {
    console.warn(`[DeepScan] ${label} enqueue failed: ${error.message}`);
  });
};

/*
const scrapeWithApify = async (username) => {
  const apifyToken = process.env.APIFY_API_KEY;
  if (!apifyToken) {
    throw new Error("APIFY_API_KEY not configured in environment variables");
  }

  const client = new ApifyClient({ token: apifyToken });

  console.log(`[Apify] Starting scrape for username: ${username}`);

  const input = {
    usernames: [`https://www.instagram.com/${username}/`],
  };

  try {
    const run = await client.actor(APIFY_INSTAGRAM_PROFILE_ACTOR_ID).call(input);
    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    if (!items || items.length === 0) {
      throw new Error("No data returned from Apify");
    }

    console.log("[Apify] Successfully scraped profile");
    return items[0];
  } catch (error) {
    console.log("[Apify] Error:", error.message);
    throw error;
  }
};

const scrapeWithApifyBulk = async (usernames) => {
  const apifyToken = process.env.APIFY_API_KEY;
  if (!apifyToken) {
    throw new Error("APIFY_API_KEY not configured in environment variables");
  }

  const client = new ApifyClient({ token: apifyToken });

  console.log(
    `[Apify Bulk] Starting bulk scrape for ${usernames.length} usernames`,
  );

  const instagramUrls = usernames.map(
    (username) => `https://www.instagram.com/${username}/`,
  );

  const input = {
    usernames: instagramUrls,
  };

  try {
    const run = await client.actor(APIFY_INSTAGRAM_PROFILE_ACTOR_ID).call(input);
    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    if (!items || items.length === 0) {
      throw new Error("No data returned from Apify bulk scrape");
    }

    console.log(`[Apify Bulk] Successfully scraped ${items.length} profiles`);
    return items;
  } catch (error) {
    console.log("[Apify Bulk] Error:", error.message);
    throw error;
  }
};
*/

// Legacy HTML scraper removed. Use scrapeWithInstagramAPI/scrapeWithInstagramAPIBulk.

// ═══════════════════════════════════════════════════════════════════════════
// Instagram JSON API Scraper (i.instagram.com)
// ═══════════════════════════════════════════════════════════════════════════
const scrapeWithInstagramAPI = async (
  username,
  cookieString = null,
  forcedProxyConfig = null,
  { maxRequestRetries = INSTAGRAM_JSON_RETRIES } = {},
) => {
  const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  // const url = `https://i.instagram.com/api/v1/users/${encodeURIComponent(username)}/usernameinfo`;
  // const url = `https://instagram.com/${encodeURIComponent(username)}/?__a=1&__d=dis`;
  const headers = {
    "User-Agent": "Instagram 219.0.0.12.117 Android",
    "X-IG-App-ID": "936619743392459",
    Accept: "application/json",
  };

  if (cookieString) {
    const csrftoken = cookieString.match(/csrftoken=([^;]+)/)?.[1];
    headers["Cookie"] = cookieString;
    if (csrftoken) headers["X-CSRFToken"] = csrftoken;
  }

  console.log(`[InstagramAPI] Fetching profile for @${username} via CheerioCrawler`);

  const responseData = await fetchJsonWithCheerioCrawler({
    url,
    headers,
    label: `instagram-profile-${username}`,
    forcedProxyConfig,
    maxRequestRetries,
    timeoutSecs: 30,
  });

  const user = responseData?.user ?? responseData?.data?.user ?? null;
  console.log(`[InstagramAPI] Received data for @${username}: ${user ? JSON.stringify(user) : "no user data"}`);
  if (!user)
    throw new Error(
      `No user data returned from Instagram API for @${username}`,
    );

  const bio = user.biography || "";
  const bioEmails = extractEmails(bio);
  const bioPhones = extractPhones(bio);

  if (user.business_email) bioEmails.push(user.business_email);
  if (user.business_phone_number) bioPhones.push(user.business_phone_number);

  // Collect external URLs
  const extUrls = (user.bio_links || []).map((l) => l.url).filter(Boolean);
  if (user.external_url && !extUrls.includes(user.external_url))
    extUrls.unshift(user.external_url);

  // Deep-scan external URLs for additional contacts
  let urlEmails = [];
  let urlPhones = [];
  if (DEEP_SCAN_INLINE_SINGLE_PROFILE && extUrls.length > 0) {
    console.log(
      `[InstagramAPI] @${username}: deep-scanning ${extUrls.length} external URL(s)...`,
    );
    for (const extUrl of extUrls) {
      try {
        const scan = await deepScanExternalUrl(extUrl);
        urlEmails.push(...(scan.emails ?? []));
        urlPhones.push(...(scan.phone_numbers ?? []));
      } catch (scanErr) {
        console.log(
          `[InstagramAPI] Deep-scan failed for ${extUrl}: ${scanErr.message}`,
        );
      }
    }
  }

  const allEmails = uniqueValues([...bioEmails, ...urlEmails]);
  const allPhones = uniqueValues([...bioPhones, ...urlPhones]);

  console.log(
    `[InstagramAPI] @${username} → ${allEmails.length} email(s), ${allPhones.length} phone(s)`,
  );

  return {
    id: user.id ?? null,
    username: user.username ?? username,
    fullName: user.full_name ?? null,
    biography: bio,
    followersCount: user.edge_followed_by?.count ?? null,
    followsCount: user.edge_follow?.count ?? null,
    postsCount: user.edge_owner_to_timeline_media?.count ?? null,
    profilePicUrl: user.profile_pic_url ?? null,
    profilePicUrlHD: user.profile_pic_url_hd ?? null,
    externalUrl: user.external_url ?? null,
    externalUrlShimmed: user.external_url_linkshimmed ?? null,
    externalUrls: extUrls.map((u) => ({ url: u })),
    verified: user.is_verified ?? false,
    private: user.is_private ?? false,
    businessCategoryName: user.business_category_name ?? null,
    emails: allEmails,
    phone_numbers: allPhones,
  };
};

// Bulk version of scrapeWithInstagramAPI
const scrapeWithInstagramAPIBulk = async (
  usernames,
  cookieString = null,
  options = {},
) => {
  const context = {
    jobType: normalizeJobType(options?.context?.jobType || "bulk_profiles"),
    jobId: options?.context?.jobId || null,
    userId: options?.context?.userId || null,
  };

  const enrichment = await enrichProfiles(usernames, {
    context,
    chunkSize: options.chunkSize || 50,
    maxChunkSize: options.maxChunkSize || 50,
    cachedUsernames: options.cachedUsernames,
    budgetUsd: options.budgetUsd,
    allowSingleAsFinalLeftover: Boolean(options.allowSingleAsFinalLeftover),
    onChunkComplete: options.onChunkComplete,
  });

  if (options.returnMeta) {
    return enrichment;
  }

  if (enrichment.stage === "SKIPPED_COST_LIMIT") {
    console.warn(
      `[InstagramAPI Bulk] Skipped due to cost limit (estimated=${enrichment.estimatedCost}, budget=${enrichment.budgetUsd})`,
    );
    return [];
  }

  return enrichment.profiles || [];
};

// ═══════════════════════════════════════════════════════════════════════════
// SteadyAPI Fallback
// ═══════════════════════════════════════════════════════════════════════════
const emitScrapeRealtime = ({
  userId,
  event,
  payload = {},
  label = "Instagram GraphQL",
}) => {
  if (!userId || !event) return;

  try {
    const io = getIO();
    io.to(`user:${userId}`).emit(event, {
      event,
      user_id: userId,
      ...payload,
      ts: Date.now(),
    });
  } catch (wsErr) {
    console.warn(`[${label}] WebSocket emit failed (non-fatal): ${wsErr.message}`);
  }
};

const parseRetryAfterMs = (retryAfterHeader) => {
  if (!retryAfterHeader) return null;

  const seconds = Number(retryAfterHeader);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(retryAfterHeader);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return null;
};

const getProfileDetailRateLimitDelayMs = (error, attempt) => {
  const retryAfterMs = parseRetryAfterMs(
    error?.response?.headers?.["retry-after"],
  );
  const exponentialMs =
    PROFILE_DETAIL_RATE_LIMIT_BACKOFF_BASE_MS *
    2 ** Math.max(0, attempt - 1);
  const cappedMs = Math.min(
    PROFILE_DETAIL_RATE_LIMIT_BACKOFF_MAX_MS,
    Math.max(retryAfterMs || 0, exponentialMs),
  );
  const jitterMs = Math.floor(Math.random() * 10_000);

  return cappedMs + jitterMs;
};

const delayAfterProfileDetailRequest = async () => {
  if (PROFILE_DETAIL_BATCH_DELAY_MAX_MS <= 0) return;
  await humanDelay(
    PROFILE_DETAIL_BATCH_DELAY_MIN_MS,
    PROFILE_DETAIL_BATCH_DELAY_MAX_MS,
  );
};

const mapGraphQLUserWithProfile = (user, profile = null, error = null) => ({
  id: profile?.id || user.id,
  username: profile?.username || user.username,
  followers: profile?.followersCount ?? null,
  following: profile?.followsCount ?? null,
  bio: profile?.biography || null,
  category: profile?.businessCategoryName || null,
  avatar: profile?.profilePicUrlHD || profile?.profilePicUrl || user.profile_pic_url,
  full_name: profile?.fullName || user.full_name || null,
  is_verified: profile?.verified ?? user.is_verified ?? false,
  is_private: profile?.private ?? user.is_private ?? false,
  external_url: profile?.externalUrl || null,
  posts_count: profile?.postsCount ?? null,
  emails: uniqueValues(profile?.emails || []),
  phone_numbers: uniqueValues(profile?.phone_numbers || []),
  ...(error ? { error: error.message } : {}),
});

const buildInstagramRelationshipLeadPayload = ({
  user,
  type,
  targetUsername,
  scrapingMethod = "GraphQL API",
}) => {
  const { first_name, last_name } = splitName(user.full_name || "");

  return {
    first_name,
    last_name,
    company: user.username || "",
    emails: user.emails || [],
    phone_numbers: user.phone_numbers || [],
    message: `
${relationshipScrapeTitle(type)} (${scrapingMethod})

Target Profile: @${targetUsername}
Username: @${user.username || "N/A"}
Full Name: ${user.full_name || "N/A"}
Bio: ${user.bio || "N/A"}
Followers: ${user.followers || "N/A"}
Following: ${user.following || "N/A"}
Posts: ${user.posts_count || "N/A"}
Verified: ${user.is_verified ? "Yes" : "No"}
Private: ${user.is_private ? "Yes" : "No"}
Category: ${user.category || "N/A"}
Profile URL: https://www.instagram.com/${user.username}
Scraping Method: ${scrapingMethod}
${user.emails && user.emails.length > 0 ? `Emails: ${user.emails.join(", ")}` : ""}
${user.phone_numbers && user.phone_numbers.length > 0 ? `Phone Numbers: ${user.phone_numbers.join(", ")}` : ""}
    `.trim(),
    scraped_from_username: targetUsername,
    relationship_type: toRelationshipDirection(type),
    source_url: `https://www.instagram.com/${user.username}`,
    source_rul: `https://www.instagram.com/${user.username}`,
    instagram_profile_id: user.id !== user.username ? user.id : null,
    username: user.username,
    full_name: user.full_name,
    bio: user.bio,
    avatar_url: user.avatar,
    avatar_rul: user.avatar,
    followers: user.followers,
    following: user.following,
    follower_count: user.followers,
    following_count: user.following,
    total_posts: user.posts_count,
    category: user.category,
    external_url: user.external_url,
    external_url_linkshimmed: null,
    external_urls: user.external_url ? [user.external_url] : [],
    is_private: user.is_private,
    is_verified: user.is_verified,
    is_public: user.is_private !== null ? !user.is_private : null,
    fb_profile_biolink: null,
    highlight_reel_count: null,
    links: [],
    scrape_status: true,
    type: "INSTAGRAM",
  };
};

const fetchProfileDetailWithAdaptiveBackoff = async ({
  user,
  cookieString,
  sessionProxyConfig,
  batchNumber,
}) => {
  for (let attempt = 1; attempt <= PROFILE_DETAIL_RATE_LIMIT_MAX_ATTEMPTS; attempt++) {
    try {
      const profile = await scrapeWithInstagramAPI(
        user.username,
        cookieString,
        sessionProxyConfig,
        { maxRequestRetries: 0 },
      );
      return mapGraphQLUserWithProfile(user, profile);
    } catch (error) {
      if (isRateLimitError(error)) {
        if (attempt >= PROFILE_DETAIL_RATE_LIMIT_MAX_ATTEMPTS) {
          console.warn(
            `[Instagram GraphQL] Batch #${batchNumber}: web_profile_info still rate-limited for @${user.username} after ${attempt} attempt(s)`,
          );
          throw error;
        }

        const waitMs = getProfileDetailRateLimitDelayMs(error, attempt);
        console.warn(
          `[Instagram GraphQL] Batch #${batchNumber}: 429 while fetching @${user.username}; waiting ${Math.round(waitMs / 1000)}s before retry ${attempt + 1}/${PROFILE_DETAIL_RATE_LIMIT_MAX_ATTEMPTS}`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      if (isAuthError(error)) {
        throw error;
      }

      console.warn(
        `[Instagram GraphQL] web_profile_info failed for @${user.username}; using GraphQL fallback: ${error.message}`,
      );
      return mapGraphQLUserWithProfile(user, null, error);
    }
  }

  return mapGraphQLUserWithProfile(user, null);
};

const enrichGraphQLBatchWithInstagramAPI = async ({
  users,
  cookieString,
  sessionProxyConfig,
  batchNumber,
  relationshipType,
  jobId,
  userId,
  processedCountBeforeBatch = 0,
}) => {
  const enrichedUsers = [];
  const startedAt = Date.now();
  let chunksProcessedInBatch = 0;

  const queryName =
    relationshipType === "following"
      ? "edge_follow"
      : "edge_followed_by";

  console.log(
    JSON.stringify({
      event: "instagram_query_batch_started",
      job_id: jobId || null,
      query_name: queryName,
      batch_number: batchNumber,
      result_count: users.length,
      total_count: null,
    }),
  );

  const usernameList = users.map((user) => user.username).filter(Boolean);
  const apifyResult = await scrapeWithInstagramAPIBulk(usernameList, cookieString, {
    context: {
      jobType: relationshipType === "following" ? "following" : "followers",
      jobId,
      userId,
    },
    // Hard enforce 50-sized chunks for relationship enrichment.
    chunkSize: 50,
    maxChunkSize: 50,
    allowSingleAsFinalLeftover: processedCountBeforeBatch > 0,
    returnMeta: true,
    onChunkComplete: ({ chunkIndex, inputCount, outputCount, metricsSnapshot }) => {
      chunksProcessedInBatch += 1;
      emitScrapeRealtime({
        userId,
        event: "scrape:enrichment_chunk",
        payload: {
          job_id: jobId || null,
          type: relationshipType,
          batch_number: batchNumber,
          chunk_index: chunkIndex,
          chunk_input_count: inputCount,
          chunk_output_count: outputCount,
          chunks_processed_in_batch: chunksProcessedInBatch,
          ...metricsSnapshot,
        },
      });
    },
  });

  const profileMap = apifyResult.profileByUsername || new Map();

  for (const user of users) {
    const profile = profileMap.get(String(user.username || "").toLowerCase()) || null;
    enrichedUsers.push(mapGraphQLUserWithProfile(user, profile));
  }

  if (apifyResult.stage === "SKIPPED_COST_LIMIT") {
    console.warn(
      `[Instagram GraphQL] Skipping Apify enrichment due to cost limit (estimated=${apifyResult.estimatedCost}, budget=${apifyResult.budgetUsd})`,
    );
  }

  console.log(
    JSON.stringify({
      event: "instagram_query_batch_finished",
      job_id: jobId || null,
      query_name: queryName,
      result_count: enrichedUsers.length,
      total_count: null,
      elapsed_ms: Date.now() - startedAt,
      apify_metrics: apifyResult.metrics,
      enrichment_stage: apifyResult.stage,
    }),
  );

  return enrichedUsers;
};

const saveInstagramRelationshipBatch = async ({
  enrichedUsers,
  user_id,
  folder_id,
  targetUsername,
  type,
  jobId = null,
}) => {
  if (!enrichedUsers.length) {
    return {
      insertedLeads: [],
      cachedCount: 0,
      newCount: 0,
      linkedCount: 0,
    };
  }

  let reservedCredits = 0;
  const leadsToInsert = enrichedUsers.map((user) =>
    buildInstagramRelationshipLeadPayload({
      user,
      type,
      targetUsername,
      scrapingMethod: "GraphQL API + web_profile_info",
    }),
  );

  try {
    reservedCredits = await reserveScrapedProfileCredits(
      user_id,
      leadsToInsert.length,
    );

    const bulkResult = await userLeadService.bulkResolveOrCreate(
      leadsToInsert,
      {
        user_id,
        folder_id,
        type: "INSTAGRAM",
        scraped_from_username: targetUsername,
        relationship_type: toRelationshipDirection(type),
      },
    );

    await refundUnusedScrapedProfileCredits(
      user_id,
      reservedCredits,
      bulkResult.insertedLeads.length,
    );
    enqueueRelationshipDeepScans({
      user_id,
      job_id: jobId,
      leads: bulkResult.insertedLeads,
      label: "Instagram GraphQL",
    });
    console.log(
      `[Instagram] Done — new: ${bulkResult.newCount}, from cache: ${bulkResult.cachedCount}`,
    );
    return {
      insertedLeads: bulkResult.insertedLeads,
      cachedCount: bulkResult.cachedCount,
      newCount: bulkResult.newCount,
      linkedCount: bulkResult.userLeads?.insertedCount || 0,
    };
  } catch (error) {
    await refundUnusedScrapedProfileCredits(user_id, reservedCredits, 0);
    throw error;
  }
};

const scrapeWithSteadyAPI = async (username) => {
  console.log(`[SteadyAPI] Fallback scrape for username: ${username}`);

  try {
    const response = await axios.get(
      `https://api.steadyapi.com/v1/instagram/profile?username=${username}`,
      {
        timeout: 30000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      },
    );

    if (!response.data?.body) {
      throw new Error("Invalid response from SteadyAPI");
    }

    console.log("[SteadyAPI] Successfully scraped profile");
    return response.data.body;
  } catch (error) {
    console.log("[SteadyAPI] Error:", error.message);
    throw error;
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Transform Apify Response to Lead Format
// ═══════════════════════════════════════════════════════════════════════════
const transformApifyToLead = (apifyData) => {
  const { first_name, last_name } = splitName(apifyData.fullName);

  // Extract emails and phones from bio
  const bioEmails = extractEmails(apifyData.biography || "");
  const bioPhones = extractPhones(apifyData.biography || "");

  // Extract external URLs
  const externalUrls = uniqueValues(
    [
      apifyData.externalUrl,
      ...(Array.isArray(apifyData.externalUrls)
        ? apifyData.externalUrls.map((link) => link.url).filter(Boolean)
        : []),
    ].filter(Boolean),
  );

  // Build profile data structure
  const profileData = {
    instagram_profile_id: apifyData.id || null,
    username: apifyData.username || null,
    full_name: apifyData.fullName || null,
    bio: apifyData.biography || null,
    avatar_url: apifyData.profilePicUrlHD || apifyData.profilePicUrl || null,
    followers: parseCount(apifyData.followersCount),
    following: parseCount(apifyData.followsCount),
    total_posts: parseCount(apifyData.postsCount),
    category: apifyData.businessCategoryName || null,
    external_url: apifyData.externalUrl || null,
    external_url_linkshimmed: apifyData.externalUrlShimmed || null,
    external_urls: externalUrls,
    is_private: apifyData.private ?? null,
    is_verified: apifyData.verified ?? null,
    is_public: apifyData.private !== null ? !apifyData.private : null,
    highlight_reel_count: parseCount(apifyData.highlightReelCount),
    links: Array.isArray(apifyData.externalUrls) ? apifyData.externalUrls : [],
    source_url:
      apifyData.url || `https://www.instagram.com/${apifyData.username}`,
  };

  return {
    profileData,
    first_name,
    last_name,
    bioEmails,
    bioPhones,
    externalUrls,
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// Transform SteadyAPI Response to Lead Format
// ═══════════════════════════════════════════════════════════════════════════
const transformSteadyAPIToLead = (steadyData) => {
  const { first_name, last_name } = splitName(steadyData.full_name);

  const bioEmails = extractEmails(steadyData.biography || "");
  const bioPhones = extractPhones(steadyData.biography || "");

  const externalUrls = uniqueValues(
    [
      steadyData.external_url,
      ...(Array.isArray(steadyData.bio_links)
        ? steadyData.bio_links.map((link) => link.url).filter(Boolean)
        : []),
    ].filter(Boolean),
  );

  const profileData = {
    instagram_profile_id: steadyData.id || null,
    username: steadyData.username || null,
    full_name: steadyData.full_name || null,
    bio: steadyData.biography || null,
    avatar_url: steadyData.profile_pic_hd || steadyData.profile_pic || null,
    followers: parseCount(steadyData.followers),
    following: parseCount(steadyData.following),
    total_posts: parseCount(steadyData.posts),
    category: steadyData.category || null,
    external_url: steadyData.external_url || null,
    external_url_linkshimmed: null,
    external_urls: externalUrls,
    is_private: steadyData.is_private ?? null,
    is_verified: steadyData.is_verified ?? null,
    is_public: steadyData.is_private !== null ? !steadyData.is_private : null,
    highlight_reel_count: parseCount(steadyData.highlight_reel_count),
    links: Array.isArray(steadyData.bio_links) ? steadyData.bio_links : [],
    source_url:
      steadyData.profile_url ||
      `https://www.instagram.com/${steadyData.username}`,
  };

  return {
    profileData,
    first_name,
    last_name,
    bioEmails,
    bioPhones,
    externalUrls,
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// Main Function: Scrape Instagram Profile
// ═══════════════════════════════════════════════════════════════════════════
const scrapeInstagram = async ({ profileUrl, user_id, folder_id }) => {
  if (!profileUrl) {
    return {
      code: 400,
      success: false,
      message: "instagram-profile-url-is-required",
    };
  }

  // Extract username from URL
  let username;
  try {
    const url = new URL(profileUrl);
    username = url.pathname.split("/").filter(Boolean)[0];
    if (!username) {
      throw new Error("Invalid Instagram URL");
    }
  } catch (error) {
    return {
      code: 400,
      success: false,
      message: "invalid-instagram-url",
      error: error.message,
    };
  }

  let profileData;
  let first_name, last_name, bioEmails, bioPhones, externalUrls;
  let scrapedWith = "instagram-api";

  // Try Instagram API first
  try {
    const apifyData = await scrapeWithInstagramAPI(username);
    const transformed = transformApifyToLead(apifyData);
    profileData = transformed.profileData;
    first_name = transformed.first_name;
    last_name = transformed.last_name;
    bioEmails = transformed.bioEmails;
    bioPhones = transformed.bioPhones;
    externalUrls = transformed.externalUrls;
  } catch (apifyError) {
    console.log("[Main] Instagram API failed, trying SteadyAPI fallback");

    // Fallback to SteadyAPI
    try {
      const steadyData = await scrapeWithSteadyAPI(username);
      const transformed = transformSteadyAPIToLead(steadyData);
      profileData = transformed.profileData;
      first_name = transformed.first_name;
      last_name = transformed.last_name;
      bioEmails = transformed.bioEmails;
      bioPhones = transformed.bioPhones;
      externalUrls = transformed.externalUrls;
      scrapedWith = "steadyapi";
    } catch (steadyError) {
      console.log("[Main] Both Apify and SteadyAPI failed");
      return {
        code: 500,
        success: false,
        message: "failed-to-scrape-instagram-profile",
        errors: {
          apify: apifyError.message,
          steadyapi: steadyError.message,
        },
      };
    }
  }

  // Perform deep scan on external URLs
  let deepScanResults = [];
  let allEmails = [...bioEmails];
  let allPhones = [...bioPhones];
  let skippedCount = 0;

  if (DEEP_SCAN_INLINE_SINGLE_PROFILE && externalUrls.length > 0) {
    console.log(`[Main] Starting deep scan for ${externalUrls.length} URLs`);

    for (const url of externalUrls) {
      const scanResult = await deepScanExternalUrl(url);

      if (scanResult.skipped) {
        skippedCount++;
      }

      deepScanResults.push(scanResult);

      if (scanResult.emails.length > 0) {
        allEmails.push(...scanResult.emails);
      }
      if (scanResult.phone_numbers.length > 0) {
        allPhones.push(...scanResult.phone_numbers);
      }

      // Small delay between requests
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    console.log(
      `[Main] Deep scan completed. Scanned: ${externalUrls.length - skippedCount}, Skipped: ${skippedCount}`,
    );
  }

  // Unique values
  allEmails = uniqueValues(allEmails);
  allPhones = uniqueValues(allPhones);

  // Create or reuse Lead + link via UserLead (dedup-aware)
  try {
    const leadPayload = {
      first_name,
      last_name,
      company: profileData.username || "",
      emails: allEmails,
      phone_numbers: allPhones,
      message: `
Instagram Profile Scraped

Username: ${profileData.username || "N/A"}
Full Name: ${profileData.full_name || "N/A"}
Bio: ${profileData.bio || "N/A"}
Followers: ${profileData.followers || "N/A"}
Following: ${profileData.following || "N/A"}
Profile URL: ${profileData.source_url}
Scraped with: ${scrapedWith.toUpperCase()}
      `.trim(),
      source_url: profileData.source_url,
      source_rul: profileData.source_url,
      instagram_profile_id: profileData.instagram_profile_id,
      username: profileData.username,
      full_name: profileData.full_name,
      bio: profileData.bio,
      avatar_url: profileData.avatar_url,
      avatar_rul: profileData.avatar_url,
      followers: profileData.followers,
      following: profileData.following,
      follower_count: profileData.followers,
      following_count: profileData.following,
      total_posts: profileData.total_posts,
      category: profileData.category,
      external_url: profileData.external_url,
      external_url_linkshimmed: profileData.external_url_linkshimmed,
      external_urls: profileData.external_urls,
      is_private: profileData.is_private,
      is_verified: profileData.is_verified,
      is_public: profileData.is_public,
      fb_profile_biolink: null,
      highlight_reel_count: null,
      links: profileData.links,
      scrape_status: true,
      type: "INSTAGRAM",
    };

    const { lead, fromCache } = await userLeadService.resolveOrCreateLead(
      leadPayload,
      { user_id, folder_id, type: "INSTAGRAM" },
    );

    if (!DEEP_SCAN_INLINE_SINGLE_PROFILE && externalUrls.length > 0) {
      enqueueDeepScanBatch({
        user_id,
        lead_ids: externalUrls.map(() => lead?._id),
        urls: externalUrls,
        job_id: null,
      }).catch((error) => {
        console.warn(
          `[DeepScan] enqueue failed for @${profileData.username}: ${error.message}`,
        );
      });
    }

    return {
      code: 200,
      success: true,
      message: fromCache
        ? "instagram-profile-fetched-from-cache"
        : "instagram-profile-scraped-successfully",
      scraped_with: scrapedWith,
      from_cache: fromCache,
      data: {
        lead,
        profile: profileData,
        deep_scan: {
          scanned_urls: deepScanResults.length,
          results: deepScanResults,
          total_emails_found: allEmails.length,
          total_phones_found: allPhones.length,
        },
      },
    };
  } catch (dbError) {
    console.error("[Main] Database error:", dbError);
    return {
      code: 500,
      success: false,
      message: "failed-to-save-lead-to-database",
      error: dbError.message,
    };
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Bulk Instagram Profile Scraper
// ═══════════════════════════════════════════════════════════════════════════
const scrapeInstagramBulk = async ({ profileUrls, user_id, folder_id }) => {
  if (!profileUrls || !Array.isArray(profileUrls) || profileUrls.length === 0) {
    return {
      code: 400,
      success: false,
      message: "profileUrls array is required and cannot be empty",
    };
  }

  console.log(`[Bulk] Starting bulk scrape for ${profileUrls.length} profiles`);

  // Extract all usernames from profile URLs
  const usernames = [];
  const usernameToUrlMap = new Map();

  for (const profileUrl of profileUrls) {
    const username = profileUrl
      .replace(/https?:\/\/(www\.)?instagram\.com\//gi, "")
      .replace(/\/$/, "")
      .trim();

    if (username) {
      usernames.push(username);
      usernameToUrlMap.set(username.toLowerCase(), profileUrl);
    }
  }

  if (usernames.length === 0) {
    return {
      code: 400,
      success: false,
      message: "No valid usernames found in profileUrls",
    };
  }

  console.log(`[Bulk] Extracted ${usernames.length} valid usernames`);

  const results = [];
  const leadsToInsert = [];
  let successCount = 0;
  let failCount = 0;

  try {
    // Fetch profiles via Instagram API
    console.log(
      `[Bulk] Sending request to Instagram API for ${usernames.length} profiles...`,
    );
    const apifyBulkData = await scrapeWithInstagramAPIBulk(usernames, null, {
      context: {
        jobType: "bulk_profiles",
        userId: user_id || null,
      },
    });

    // Process each result from Apify
    for (const apifyData of apifyBulkData) {
      try {
        const transformed = transformApifyToLead(apifyData);
        const {
          profileData,
          first_name,
          last_name,
          bioEmails,
          bioPhones,
          externalUrls,
        } = transformed;

        // Unique values
        const allEmails = uniqueValues(bioEmails);
        const allPhones = uniqueValues(bioPhones);

        // Get original profile URL
        const originalUrl =
          usernameToUrlMap.get(profileData.username?.toLowerCase()) ||
          profileData.source_url;

        // Prepare lead data for bulk insert
        const leadData = {
          first_name,
          last_name,
          company: profileData.username || "",
          emails: allEmails,
          phone_numbers: allPhones,
          message: `
Instagram Profile Scraped (Bulk)

Username: ${profileData.username || "N/A"}
Full Name: ${profileData.full_name || "N/A"}
Bio: ${profileData.bio || "N/A"}
Followers: ${profileData.followers || "N/A"}
Following: ${profileData.following || "N/A"}
Profile URL: ${profileData.source_url}
Scraped with: APIFY
          `.trim(),
          source_url: profileData.source_url,
          source_rul: profileData.source_url,
          instagram_profile_id: profileData.instagram_profile_id,
          username: profileData.username,
          full_name: profileData.full_name,
          bio: profileData.bio,
          avatar_url: profileData.avatar_url,
          avatar_rul: profileData.avatar_url,
          followers: profileData.followers,
          following: profileData.following,
          follower_count: profileData.followers,
          following_count: profileData.following,
          total_posts: profileData.total_posts,
          category: profileData.category,
          external_url: profileData.external_url,
          external_url_linkshimmed: null,
          external_urls: profileData.external_urls,
          is_private: profileData.is_private,
          is_verified: profileData.is_verified,
          is_public: profileData.is_public,
          fb_profile_biolink: null,
          highlight_reel_count: null,
          links: profileData.links,
          scrape_status: true,
          type: "INSTAGRAM",
        };

        leadsToInsert.push(leadData);

        results.push({
          profileUrl: originalUrl,
          username: profileData.username,
          success: true,
          scraped_with: "apify",
          profile: profileData,
        });

        successCount++;
      } catch (transformError) {
        console.error(
          `[Bulk] Error transforming profile data:`,
          transformError.message,
        );
        results.push({
          profileUrl: apifyData.url || "unknown",
          username: apifyData.username || "unknown",
          success: false,
          error: transformError.message,
        });
        failCount++;
      }
    }

    console.log(
      `[Bulk] Processed ${successCount} profiles successfully, ${failCount} failed`,
    );
  } catch (apifyError) {
    console.error(`[Bulk] Apify bulk scrape failed:`, apifyError.message);

    // If bulk Apify fails, mark all as failed
    for (const username of usernames) {
      results.push({
        profileUrl: usernameToUrlMap.get(username.toLowerCase()),
        username: username,
        success: false,
        error: apifyError.message,
      });
      failCount++;
    }
  }

  // Bulk insert all leads into MongoDB
  let insertedLeads = [];
  if (leadsToInsert.length > 0) {
    try {
      console.log(
        `[Bulk] Inserting ${leadsToInsert.length} leads into database...`,
      );
      insertedLeads = await Lead.insertMany(leadsToInsert, { ordered: false });
      console.log(`[Bulk] Successfully inserted ${insertedLeads.length} leads`);
    } catch (dbError) {
      console.error("[Bulk] Database bulk insert error:", dbError.message);
      // Even if some fail, insertMany with ordered:false will continue
      // Check if any were inserted
      if (dbError.insertedDocs) {
        insertedLeads = dbError.insertedDocs;
      }
    }
  }

  return {
    code: 200,
    success: true,
    message: "bulk-instagram-scraping-completed",
    data: {
      total: profileUrls.length,
      success: successCount,
      failed: failCount,
      leads_inserted: insertedLeads.length,
      results: results,
      leads: insertedLeads,
    },
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// Instagram Browser Automation - Followers/Following Scraper
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════

const activeRelationshipLocks = new Map();

const buildRelationshipLockKey = ({ jobId, userId, targetUsername, type }) => {
  if (jobId) return `instagram:scrape:${jobId}`;
  return [
    "instagram:relationship",
    userId || "anonymous",
    String(targetUsername || "").trim().toLowerCase() || "unknown-target",
    normalizeRelationshipRequestType(type),
  ].join(":");
};

const acquireRelationshipLock = (context) => {
  const lockKey = buildRelationshipLockKey(context);
  if (activeRelationshipLocks.has(lockKey)) {
    return { acquired: false, lockKey };
  }

  activeRelationshipLocks.set(lockKey, {
    ...context,
    acquiredAt: Date.now(),
  });

  return { acquired: true, lockKey };
};

const releaseRelationshipLock = (lockKey) => {
  if (lockKey) activeRelationshipLocks.delete(lockKey);
};

// ═══════════════════════════════════════════════════════════════════════════
// RESOURCE LIMITS - Safe limits for EC2 micro (1GB RAM)
// ═══════════════════════════════════════════════════════════════════════════
const SAFE_SCRAPE_LIMIT = 300; // Max users to scrape per session (memory safe)
const ENRICH_LIMIT = 100; // Max users to enrich with Apify (API safe)

// Human-like delay helper
const humanDelay = (min = 1000, max = 3000) => {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, delay));
};

// Longer delay for page loads
const pageLoadDelay = () => humanDelay(2000, 4000);

// Gentle scroll delay
const scrollDelay = () => humanDelay(800, 1500);

// Type like a human
const humanType = async (page, selector, text, delayBetweenKeys = 100) => {
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

// Save cookies to file
// Save cookies to file
const saveCookies = async (page, filepath) => {
  const cookies = await page.cookies();

  // Ensure directory exists
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[Instagram] Created directory: ${dir}`);
  }

  fs.writeFileSync(filepath, JSON.stringify(cookies, null, 2));
  console.log(`[Instagram] Cookies saved to ${filepath}`);
};

// Load cookies from file
const loadCookies = async (page, filepath) => {
  if (fs.existsSync(filepath)) {
    const cookies = JSON.parse(fs.readFileSync(filepath, "utf-8"));
    await page.setCookie(...cookies);
    console.log(`[Instagram] Cookies loaded from ${filepath}`);
    return true;
  }
  return false;
};

// Check if logged in
const isLoggedIn = async (page) => {
  try {
    // Wait a bit for page to settle
    await humanDelay(1500, 2500);

    console.log("[Instagram] Running login detection checks...");

    // PRIORITY 1: Positive check - Look for elements that only appear when logged in
    const loggedInIndicator = await page.evaluate(() => {
      // Check for nav bar elements (home, search, etc.)
      const nav = document.querySelector("nav");
      if (nav) {
        // Look for home link or user menu or svg icons (indicating logged-in nav)
        const hasHomeLink = nav.querySelector('a[href="/"]');
        const hasSvg = nav.querySelector("svg");
        const hasProfileLink = nav.textContent
          .toLowerCase()
          .includes("profile");

        if ((hasHomeLink && hasSvg) || hasProfileLink) {
          console.log("[Instagram Check] Found logged-in navigation elements");
          return true;
        }
      }

      // Check for search bar or create post elements
      const hasSearchOrCreate =
        document.querySelector('input[placeholder*="Search"]') ||
        document.querySelector('[aria-label*="New post"]') ||
        document.querySelector('[aria-label*="Create"]');
      if (hasSearchOrCreate) {
        console.log("[Instagram Check] Found search/create elements");
        return true;
      }

      return false;
    });

    if (loggedInIndicator) {
      console.log(
        "[Instagram] ✓ Detected logged-in state (positive indicators)",
      );
      return true;
    }

    // PRIORITY 2: Check for login page URL
    const currentUrl = page.url();
    if (currentUrl.includes("/accounts/login")) {
      console.log("[Instagram] ✗ On login page - not logged in");
      return false;
    }

    // PRIORITY 3: Check for "Log in" dialog/modal (appears on profile pages when not logged in)
    const loginDialog = await page.evaluate(() => {
      const dialogs = document.querySelectorAll('div[role="dialog"]');
      for (const dialog of dialogs) {
        if (
          dialog.textContent.includes("Log in") ||
          dialog.textContent.includes("Sign up for Instagram")
        ) {
          console.log("[Instagram Check] Found login dialog");
          return true;
        }
      }
      return false;
    });

    if (loginDialog) {
      console.log("[Instagram] ✗ Detected login dialog - not logged in");
      return false;
    }

    // PRIORITY 4: Check for login form inputs (last resort)
    const emailInput = await page.$('input[name="email"]');
    const usernameInput = await page.$('input[name="username"]');
    const passwordInput = await page.$(
      'input[name="pass"], input[name="password"]',
    );

    if ((emailInput || usernameInput) && passwordInput) {
      console.log("[Instagram] ✗ Detected login form - not logged in");
      return false;
    }

    // If we reach here and found no negative indicators, assume logged in
    console.log("[Instagram] ✓ No login indicators found - assuming logged in");
    return true;
  } catch (error) {
    console.log("[Instagram] Error checking login status:", error.message);
    return false;
  }
};

// Dismiss Instagram prompts/dialogs (Save Login Info, Notifications, etc.)
const dismissPrompts = async (page, maxAttempts = 3) => {
  for (let i = 0; i < maxAttempts; i++) {
    await humanDelay(1000, 2000);

    const dismissed = await page.evaluate(() => {
      // Find "Not Now" buttons
      const elements = Array.from(
        document.querySelectorAll('button, div[role="button"]'),
      );
      const notNowButton = elements.find((el) => {
        const text = el.textContent.trim().toLowerCase();
        return text === "not now";
      });

      if (notNowButton) {
        const parentText = notNowButton.closest("div")?.textContent || "";
        console.log(
          `[Instagram Check] Found "Not Now" button in context: ${parentText.substring(0, 50)}...`,
        );
        notNowButton.click();
        return true;
      }

      return false;
    });

    if (dismissed) {
      console.log(`[Instagram] Dismissed prompt (attempt ${i + 1})`);
      await humanDelay(1000, 2000);
    } else {
      // No more prompts found
      console.log(`[Instagram] No more prompts to dismiss (attempt ${i + 1})`);
      break;
    }
  }
};

// Login to Instagram
const loginToInstagram = async (page) => {
  const username = process.env.INSTAGRAM_USERNAME;
  const password = process.env.INSTAGRAM_PASSWORD;
  const usernameSelector =
    process.env.INSTAGRAM_USERNAME_SELECTOR || 'input[name="username"]';
  const passwordSelector =
    process.env.INSTAGRAM_PASSWORD_SELECTOR || 'input[name="password"]';

  if (!username || !password) {
    throw new Error(
      "Instagram credentials not configured in environment variables",
    );
  }

  console.log("[Instagram] Navigating to login page...");
  await page.goto("https://www.instagram.com/accounts/login/", {
    waitUntil: "networkidle2",
    timeout: 30000,
  });

  await pageLoadDelay();

  // Give extra time for account selection screen to fully render
  await humanDelay(1500, 2500);

  // Check for account selection screen and click "Use another profile"
  console.log("[Instagram] Checking for account selection screen...");

  // Try to wait for the "Use another profile" button (up to 5 seconds)
  let useAnotherProfileClicked = false;
  try {
    await page.waitForSelector(
      '[aria-label="Use another profile"][role="button"]',
      {
        timeout: 5000,
        visible: true,
      },
    );
    console.log(
      '[Instagram] "Use another profile" button detected, clicking...',
    );

    useAnotherProfileClicked = await page.evaluate(() => {
      const useAnotherBtn = document.querySelector(
        '[aria-label="Use another profile"][role="button"]',
      );
      if (useAnotherBtn) {
        console.log('[Instagram] Clicking "Use another profile" button...');
        useAnotherBtn.click();
        return true;
      }
      return false;
    });
  } catch (error) {
    console.log(
      '[Instagram] "Use another profile" button not found within timeout, checking manually...',
    );

    // Fallback: manual search
    useAnotherProfileClicked = await page.evaluate(() => {
      const allButtons = Array.from(
        document.querySelectorAll('[role="button"]'),
      );
      console.log(
        `[Instagram] Manually checking ${allButtons.length} buttons...`,
      );

      for (const btn of allButtons) {
        const btnText = btn.textContent.trim();
        const ariaLabel = btn.getAttribute("aria-label");

        if (
          btnText.includes("Use another profile") ||
          btnText.includes("use another profile") ||
          ariaLabel?.includes("Use another profile")
        ) {
          console.log(`[Instagram] Found match, clicking...`);
          btn.click();
          return true;
        }
      }
      return false;
    });
  }

  if (useAnotherProfileClicked) {
    console.log(
      "[Instagram] Clicked 'Use another profile', waiting for login form...",
    );
    await humanDelay(2000, 3000);
  } else {
    console.log(
      "[Instagram] 'Use another profile' button not found, checking if login form is already visible...",
    );
    await humanDelay(1000, 1500);
  }

  // Check if username and password fields exist
  console.log("[Instagram] Checking for login form fields...");
  const fieldsExist = await page.evaluate(
    (usernameSelector, passwordSelector) => {
      const usernameField = document.querySelector(usernameSelector);
      const passwordField = document.querySelector(passwordSelector);
      return {
        usernameExists: !!usernameField,
        passwordExists: !!passwordField,
        usernameVisible: usernameField && usernameField.offsetParent !== null,
        passwordVisible: passwordField && passwordField.offsetParent !== null,
      };
    },
    usernameSelector,
    passwordSelector,
  );

  console.log(`[Instagram] Login fields status:`, fieldsExist);

  // If neither field exists, throw error
  if (!fieldsExist.usernameExists && !fieldsExist.passwordExists) {
    throw new Error(
      "Login form not found - no username or password fields detected",
    );
  }

  // Wait for fields to be visible if they exist but aren't visible yet
  if (
    (fieldsExist.usernameExists && !fieldsExist.usernameVisible) ||
    (fieldsExist.passwordExists && !fieldsExist.passwordVisible)
  ) {
    console.log("[Instagram] Waiting for login fields to become visible...");
    await humanDelay(1000, 2000);
  }

  // Type username only if field exists (some modals only show password for saved accounts)
  if (fieldsExist.usernameExists && fieldsExist.usernameVisible) {
    console.log("[Instagram] Typing username...");
    await humanType(page, usernameSelector, username, 120);
    await humanDelay(500, 1000);
  } else {
    console.log(
      "[Instagram] Skipping username (field not present - using saved account)",
    );
  }

  // Type password (should always be present)
  if (fieldsExist.passwordExists && fieldsExist.passwordVisible) {
    console.log("[Instagram] Typing password...");
    await humanType(page, passwordSelector, password, 100);
    await humanDelay(800, 1500);
  } else {
    throw new Error("Password field not visible or not found");
  }

  console.log("[Instagram] Clicking login button...");
  // Find and click login button by text content (more reliable than classes)
  const loginClicked = await page.evaluate(() => {
    const buttons = Array.from(
      document.querySelectorAll('button, div[role="button"]'),
    );
    const loginButton = buttons.find(
      (btn) => btn.textContent.trim().toLowerCase() === "log in",
    );
    if (loginButton) {
      loginButton.click();
      return true;
    }
    return false;
  });

  if (!loginClicked) {
    throw new Error("Login button not found");
  }

  // Wait for navigation after login
  await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 });
  await pageLoadDelay();

  // Dismiss any prompts that appear after login (Save Info, Notifications, etc.)
  console.log("[Instagram] Checking for post-login prompts...");
  await dismissPrompts(page, 3);

  console.log("[Instagram] Login successful!");
  return true;
};

// ═══════════════════════════════════════════════════════════════════════════
// GraphQL-based Instagram Scraper (Alternative Method)
// ═══════════════════════════════════════════════════════════════════════════
// List of domains to skip during deep scan (social platforms, tech giants, etc.)
const SKIP_DOMAINS = [
  "apple.com",
  "youtube.com",
  "google.com",
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "tiktok.com",
  "snapchat.com",
  "pinterest.com",
  "reddit.com",
  "amazon.com",
  "ebay.com",
  "paypal.com",
  "github.com",
  "stackoverflow.com",
  "microsoft.com",
  "zoom.us",
  "discord.com",
  "telegram.org",
  "whatsapp.com",
  "spotify.com",
  "netflix.com",
  "t.co",
  "bit.ly",
  "tinyurl.com",
];

const shouldSkipDomain = (url) => {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase().replace(/^www\\./, "");

    // Check if hostname matches or ends with any skip domain
    return SKIP_DOMAINS.some((domain) => {
      return hostname === domain || hostname.endsWith("." + domain);
    });
  } catch (error) {
    return false;
  }
};

const deepScanExternalUrl = async (externalUrl, options = {}) =>
  queuedDeepScanExternalUrl(externalUrl, options);

const enqueueRelationshipDeepScans = ({
  user_id,
  job_id,
  leads = [],
  label = "Instagram",
}) => {
  if (!DEEP_SCAN_RELATIONSHIP_ENABLED || !leads.length) {
    return;
  }

  const scanTargets = leads
    .map((lead) => ({
      lead_id: lead?._id,
      url: lead?.external_url || lead?.external_urls?.[0] || null,
    }))
    .filter((target) => target.lead_id && target.url);

  if (!scanTargets.length) {
    return;
  }

  enqueueDeepScanBatch({
    user_id,
    job_id,
    lead_ids: scanTargets.map((target) => target.lead_id),
    urls: scanTargets.map((target) => target.url),
  }).catch((error) => {
    console.warn(`[DeepScan] ${label} enqueue failed: ${error.message}`);
  });
};

/*
const scrapeWithApify = async (username) => {
  const apifyToken = process.env.APIFY_API_KEY;
  if (!apifyToken) {
    throw new Error("APIFY_API_KEY not configured in environment variables");
  }

  const client = new ApifyClient({ token: apifyToken });

  console.log(`[Apify] Starting scrape for username: ${username}`);

  const input = {
    usernames: [`https://www.instagram.com/${username}/`],
  };

  try {
    const run = await client.actor(APIFY_INSTAGRAM_PROFILE_ACTOR_ID).call(input);
    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    if (!items || items.length === 0) {
      throw new Error("No data returned from Apify");
    }

    console.log("[Apify] Successfully scraped profile");
    return items[0];
  } catch (error) {
    console.log("[Apify] Error:", error.message);
    throw error;
  }
};

const scrapeWithApifyBulk = async (usernames) => {
  const apifyToken = process.env.APIFY_API_KEY;
  if (!apifyToken) {
    throw new Error("APIFY_API_KEY not configured in environment variables");
  }

  const client = new ApifyClient({ token: apifyToken });

  console.log(
    `[Apify Bulk] Starting bulk scrape for ${usernames.length} usernames`,
  );

  const instagramUrls = usernames.map(
    (username) => `https://www.instagram.com/${username}/`,
  );

  const input = {
    usernames: instagramUrls,
  };

  try {
    const run = await client.actor(APIFY_INSTAGRAM_PROFILE_ACTOR_ID).call(input);
    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    if (!items || items.length === 0) {
      throw new Error("No data returned from Apify bulk scrape");
    }

    console.log(`[Apify Bulk] Successfully scraped ${items.length} profiles`);
    return items;
  } catch (error) {
    console.log("[Apify Bulk] Error:", error.message);
    throw error;
  }
};
*/

// Legacy HTML scraper removed. Use scrapeWithInstagramAPI/scrapeWithInstagramAPIBulk.

// ═══════════════════════════════════════════════════════════════════════════
// Instagram JSON API Scraper (i.instagram.com)
// ═══════════════════════════════════════════════════════════════════════════
const scrapeWithInstagramAPI = async (
  username,
  cookieString = null,
  forcedProxyConfig = null,
  { maxRequestRetries = INSTAGRAM_JSON_RETRIES } = {},
) => {
  const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  // const url = `https://i.instagram.com/api/v1/users/${encodeURIComponent(username)}/usernameinfo`;
  // const url = `https://instagram.com/${encodeURIComponent(username)}/?__a=1&__d=dis`;
  const headers = {
    "User-Agent": "Instagram 219.0.0.12.117 Android",
    "X-IG-App-ID": "936619743392459",
    Accept: "application/json",
  };

  if (cookieString) {
    const csrftoken = cookieString.match(/csrftoken=([^;]+)/)?.[1];
    headers["Cookie"] = cookieString;
    if (csrftoken) headers["X-CSRFToken"] = csrftoken;
  }

  console.log(`[InstagramAPI] Fetching profile for @${username} via CheerioCrawler`);

  const responseData = await fetchJsonWithCheerioCrawler({
    url,
    headers,
    label: `instagram-profile-${username}`,
    forcedProxyConfig,
    maxRequestRetries,
    timeoutSecs: 30,
  });

  const user = responseData?.user ?? responseData?.data?.user ?? null;
  console.log(`[InstagramAPI] Received data for @${username}: ${user ? JSON.stringify(user) : "no user data"}`);
  if (!user)
    throw new Error(
      `No user data returned from Instagram API for @${username}`,
    );

  const bio = user.biography || "";
  const bioEmails = extractEmails(bio);
  const bioPhones = extractPhones(bio);

  if (user.business_email) bioEmails.push(user.business_email);
  if (user.business_phone_number) bioPhones.push(user.business_phone_number);

  // Collect external URLs
  const extUrls = (user.bio_links || []).map((l) => l.url).filter(Boolean);
  if (user.external_url && !extUrls.includes(user.external_url))
    extUrls.unshift(user.external_url);

  // Deep-scan external URLs for additional contacts
  let urlEmails = [];
  let urlPhones = [];
  if (DEEP_SCAN_INLINE_SINGLE_PROFILE && extUrls.length > 0) {
    console.log(
      `[InstagramAPI] @${username}: deep-scanning ${extUrls.length} external URL(s)...`,
    );
    for (const extUrl of extUrls) {
      try {
        const scan = await deepScanExternalUrl(extUrl);
        urlEmails.push(...(scan.emails ?? []));
        urlPhones.push(...(scan.phone_numbers ?? []));
      } catch (scanErr) {
        console.log(
          `[InstagramAPI] Deep-scan failed for ${extUrl}: ${scanErr.message}`,
        );
      }
    }
  }

  const allEmails = uniqueValues([...bioEmails, ...urlEmails]);
  const allPhones = uniqueValues([...bioPhones, ...urlPhones]);

  console.log(
    `[InstagramAPI] @${username} → ${allEmails.length} email(s), ${allPhones.length} phone(s)`,
  );

  return {
    id: user.id ?? null,
    username: user.username ?? username,
    fullName: user.full_name ?? null,
    biography: bio,
    followersCount: user.edge_followed_by?.count ?? null,
    followsCount: user.edge_follow?.count ?? null,
    postsCount: user.edge_owner_to_timeline_media?.count ?? null,
    profilePicUrl: user.profile_pic_url ?? null,
    profilePicUrlHD: user.profile_pic_url_hd ?? null,
    externalUrl: user.external_url ?? null,
    externalUrlShimmed: user.external_url_linkshimmed ?? null,
    externalUrls: extUrls.map((u) => ({ url: u })),
    verified: user.is_verified ?? false,
    private: user.is_private ?? false,
    businessCategoryName: user.business_category_name ?? null,
    emails: allEmails,
    phone_numbers: allPhones,
  };
};

// Bulk version of scrapeWithInstagramAPI
const scrapeWithInstagramAPIBulk = async (
  usernames,
  cookieString = null,
  options = {},
) => {
  const context = {
    jobType: normalizeJobType(options?.context?.jobType || "bulk_profiles"),
    jobId: options?.context?.jobId || null,
    userId: options?.context?.userId || null,
  };

  const enrichment = await enrichProfiles(usernames, {
    context,
    chunkSize: options.chunkSize || 50,
    maxChunkSize: options.maxChunkSize || 50,
    cachedUsernames: options.cachedUsernames,
    budgetUsd: options.budgetUsd,
    allowSingleAsFinalLeftover: Boolean(options.allowSingleAsFinalLeftover),
    onChunkComplete: options.onChunkComplete,
  });

  if (options.returnMeta) {
    return enrichment;
  }

  if (enrichment.stage === "SKIPPED_COST_LIMIT") {
    console.warn(
      `[InstagramAPI Bulk] Skipped due to cost limit (estimated=${enrichment.estimatedCost}, budget=${enrichment.budgetUsd})`,
    );
    return [];
  }

  return enrichment.profiles || [];
};

// ═══════════════════════════════════════════════════════════════════════════
// SteadyAPI Fallback
// ═══════════════════════════════════════════════════════════════════════════
const emitScrapeRealtime = ({
  userId,
  event,
  payload = {},
  label = "Instagram GraphQL",
}) => {
  if (!userId || !event) return;

  try {
    const io = getIO();
    io.to(`user:${userId}`).emit(event, {
      event,
      user_id: userId,
      ...payload,
      ts: Date.now(),
    });
  } catch (wsErr) {
    console.warn(`[${label}] WebSocket emit failed (non-fatal): ${wsErr.message}`);
  }
};

const parseRetryAfterMs = (retryAfterHeader) => {
  if (!retryAfterHeader) return null;

  const seconds = Number(retryAfterHeader);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(retryAfterHeader);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return null;
};

const getProfileDetailRateLimitDelayMs = (error, attempt) => {
  const retryAfterMs = parseRetryAfterMs(
    error?.response?.headers?.["retry-after"],
  );
  const exponentialMs =
    PROFILE_DETAIL_RATE_LIMIT_BACKOFF_BASE_MS *
    2 ** Math.max(0, attempt - 1);
  const cappedMs = Math.min(
    PROFILE_DETAIL_RATE_LIMIT_BACKOFF_MAX_MS,
    Math.max(retryAfterMs || 0, exponentialMs),
  );
  const jitterMs = Math.floor(Math.random() * 10_000);

  return cappedMs + jitterMs;
};

const delayAfterProfileDetailRequest = async () => {
  if (PROFILE_DETAIL_BATCH_DELAY_MAX_MS <= 0) return;
  await humanDelay(
    PROFILE_DETAIL_BATCH_DELAY_MIN_MS,
    PROFILE_DETAIL_BATCH_DELAY_MAX_MS,
  );
};

const mapGraphQLUserWithProfile = (user, profile = null, error = null) => ({
  id: profile?.id || user.id,
  username: profile?.username || user.username,
  followers: profile?.followersCount ?? null,
  following: profile?.followsCount ?? null,
  bio: profile?.biography || null,
  category: profile?.businessCategoryName || null,
  avatar: profile?.profilePicUrlHD || profile?.profilePicUrl || user.profile_pic_url,
  full_name: profile?.fullName || user.full_name || null,
  is_verified: profile?.verified ?? user.is_verified ?? false,
  is_private: profile?.private ?? user.is_private ?? false,
  external_url: profile?.externalUrl || null,
  posts_count: profile?.postsCount ?? null,
  emails: uniqueValues(profile?.emails || []),
  phone_numbers: uniqueValues(profile?.phone_numbers || []),
  ...(error ? { error: error.message } : {}),
});

const buildInstagramRelationshipLeadPayload = ({
  user,
  type,
  targetUsername,
  scrapingMethod = "GraphQL API",
}) => {
  const { first_name, last_name } = splitName(user.full_name || "");

  return {