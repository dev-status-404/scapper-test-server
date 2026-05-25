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
import {
  applyContactSnapshotToProfile,
  buildDeepScanTargetsForLeads,
} from "./instagram/contactEnrichmentService.js";
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

  const scanTargets = buildDeepScanTargetsForLeads(leads);
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
      leads: [
        ...(bulkResult.insertedLeads || []),
        ...(bulkResult.cachedLeads || []),
      ],
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

/**
 * Scrape followers/following using Instagram GraphQL API.
 * Faster and more memory-efficient than Puppeteer-based scraping.
 *
 * @param {Object} params - Scraping parameters
 * @returns {Object} Same format as Puppeteer scraper
 */
const scrapeFollowersOrFollowingGraphQL = async ({
  targetUsername,
  type = "followers",
  maxLimit = 500,
  user_id,
  folder_id,
  __checkPause,
  __job_id,
}) => {
  type = normalizeRelationshipRequestType(type);
  let igAccount = null; // Track account for release

  console.log(
    `[Instagram GraphQL] Starting ${type} scraper for @${targetUsername}`,
  );

  try {
    // ═══════════════════════════════════════════════════════════════════════════
    // SMART CACHE CHECK via UserLead (preliminary — totalOnProfile not yet known)
    // ═══════════════════════════════════════════════════════════════════════════
    const _relType = toRelationshipDirection(type);
    let _cache = { count: 0, leads: [] };
    try {
      _cache = await userLeadService.getExistingFollowersForTarget(
        user_id,
        targetUsername,
        _relType,
      );
    } catch (cacheErr) {
      console.warn(
        `[Instagram GraphQL] Cache lookup failed (non-fatal): ${cacheErr.message}`,
      );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 1: Load Session Cookies from Account Pool
    // ═══════════════════════════════════════════════════════════════════════════
    console.log("[Instagram GraphQL] Selecting account from pool...");
    // Get account from pool
    igAccount = await accountPool.getNextAccount(user_id);
    console.log(`[Instagram GraphQL] Using account: @${igAccount.username}`);

    // Load encrypted cookies from account
    const cookies = igAccount.getCookies();

    // Handle decryption failure
    if (!cookies || !Array.isArray(cookies)) {
      const error = new Error(
        `Cookie decryption failed for account @${igAccount.username}. ` +
          `This usually happens when COOKIE_ENCRYPTION_KEY is not set in .env or has changed. ` +
          `Please re-import the account or update cookies via API.`,
      );
      error.name = "CookieDecryptionError";
      throw error;
    }

    console.log(`[Instagram GraphQL] Loaded ${cookies.length} cookies`);

    // Extract sessionid and csrftoken
    const sessionCookie = cookies.find((c) => c.name === "sessionid");
    const csrfCookie = cookies.find((c) => c.name === "csrftoken");

    if (!sessionCookie || !csrfCookie) {
      throw new Error(
        "Session cookies not found. Please login via Puppeteer first.",
      );
    }

    const sessionid = sessionCookie.value;
    const csrftoken = csrfCookie.value;

    // Build cookie string
    const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const sessionProxyConfig = getNextProxyConfig();

    console.log(
      `[Instagram GraphQL] Session loaded successfully (proxy port ${sessionProxyConfig.port})`,
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 2: Get Target User ID via Apify
    // ═══════════════════════════════════════════════════════════════════════════
    console.log(
      `[Instagram GraphQL] Fetching user ID for @${targetUsername} via Apify...`,
    );

    let userId;
    let totalOnProfile = null; // total followers/following count on the profile
    try {
      let apifyData = getCachedTargetProfile(targetUsername);
      if (apifyData) {
        console.log(
          `[Instagram GraphQL] Using cached target profile for @${targetUsername}`,
        );
      } else {
        apifyData = await enrichProfile(targetUsername, {
          context: {
            jobType: "single_profile",
            jobId: String(__job_id || ""),
            userId: String(user_id || ""),
          },
          allowSingleAsFinalLeftover: true,
        });
        if (!apifyData) {
          throw new Error(`Apify returned no profile data for @${targetUsername}`);
        }
        setCachedTargetProfile(targetUsername, apifyData);
      }
      userId = apifyData.id;
      if (!userId) {
        throw new Error(`Apify profile returned no user ID for @${targetUsername}`);
      }

      // Capture the real total count from Apify profile data
      totalOnProfile =
        type === "followers"
          ? (apifyData.followersCount ?? apifyData.followers_count ?? null)
          : (apifyData.followsCount ?? apifyData.follows_count ?? null);

      console.log(
        `[Instagram GraphQL] Found user ID: ${userId}, totalOnProfile (${type}): ${totalOnProfile ?? "unknown"}`,
      );
    } catch (apifyError) {
      const staleProfile = getCachedTargetProfile(targetUsername, {
        allowStale: true,
      });
      if (staleProfile?.id) {
        console.warn(
          `[Instagram GraphQL] Apify lookup failed; falling back to cached target profile for @${targetUsername}: ${apifyError.message}`,
        );
        userId = staleProfile.id;
        totalOnProfile =
          type === "followers"
            ? (staleProfile.followersCount ??
              staleProfile.followers_count ??
              null)
            : (staleProfile.followsCount ??
              staleProfile.follows_count ??
              null);
      } else {
        console.error(
          `[Instagram GraphQL] Apify error:`,
          apifyError.message,
        );
        throw new Error(
          `Could not fetch profile for @${targetUsername} via Apify. ${apifyError.message}`,
        );
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SMART CACHE DECISION (now that totalOnProfile is known)
    // Rule 1: maxLimit >= totalOnProfile → user wants all (or more than exist)
    //         └─ cached >= totalOnProfile → profile fully cached, return as-is
    //         └─ cached <  totalOnProfile → scrape remaining (totalOnProfile - cached)
    // Rule 2: maxLimit <  totalOnProfile → user wants a capped slice
    //         └─ cached >= maxLimit       → full cache hit for this limit, return slice
    //         └─ cached <  maxLimit       → scrape delta (maxLimit - cached)
    // ═══════════════════════════════════════════════════════════════════════════
    const _cacheThreshold =
      totalOnProfile !== null
        ? Math.min(maxLimit, totalOnProfile) // can't cache more than what exists
        : maxLimit;

    if (_cache.count >= _cacheThreshold) {
      const cachedLeads = _cache.leads.slice(0, _cacheThreshold);
      console.log(
        `[Instagram GraphQL] Full cache hit: ${_cache.count} cached >= threshold ${_cacheThreshold} (maxLimit=${maxLimit}, totalOnProfile=${totalOnProfile ?? "unknown"}). Returning without scraping.`,
      );
      return {
        code: 200,
        success: true,
        message: `${type}-retrieved-from-cache`,
        data: {
          target_username: targetUsername,
          type,
          count: cachedLeads.length,
          enriched_count: cachedLeads.length,
          leads_inserted: 0,
          cached_count: cachedLeads.length,
          total_on_profile: totalOnProfile,
          max_limit: maxLimit,
          missing_count: 0,
          completion_percentage: totalOnProfile
            ? ((cachedLeads.length / totalOnProfile) * 100).toFixed(1)
            : 100,
          status_message: `Retrieved ${cachedLeads.length} ${type} from cache`,
          scraping_method: "UserLead Cache (GraphQL)",
          users: cachedLeads,
          leads: cachedLeads,
          cached: true,
        },
      };
    }

    // How many NEW records do we still need?
    const effectiveLimit = _cacheThreshold - _cache.count;
    console.log(
      `[Instagram GraphQL] Need ${effectiveLimit} more (cached=${_cache.count}, threshold=${_cacheThreshold}, totalOnProfile=${totalOnProfile ?? "unknown"})`,
    );

    // Build a fast-lookup set of already-cached usernames so the scrape loop
    // skips them and only counts genuinely new accounts toward effectiveLimit.
    const cachedUsernameSet = new Set(
      (_cache.leads || [])
        .map((l) => (l.username ? l.username.toLowerCase() : null))
        .filter(Boolean),
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 3: GraphQL Query Configuration
    // ═══════════════════════════════════════════════════════════════════════════
    const QUERY_HASHES = {
      followers: "c76146de99bb02f6415203be841dd25a",
      following: "d04b0a864b4b54837c0d870b0e77e076",
    };

    const queryHash = QUERY_HASHES[type];
    const graphqlUrl = "https://www.instagram.com/graphql/query/";

    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 4: Pagination Loop - Fetch All Users
    // ═══════════════════════════════════════════════════════════════════════════
    console.log(`[Instagram GraphQL] Starting pagination to fetch ${type}...`);

    const seenUsernameSet = new Set();
    const resultUsersPreview = [];
    const resultLeadsPreview = [];
    let hasNextPage = true;
    let afterCursor = null;
    let requestCount = 0;
    let sampleFollowerLogged = false;
    let totalProcessed = 0;
    let totalInserted = 0;
    let totalExistingLeadCache = 0;
    let totalLinked = 0;

    while (hasNextPage && totalProcessed < effectiveLimit) {
      requestCount++;

      const variables = {
        id: userId,
        include_reel: true,
        fetch_mutual: false,
        first: GRAPHQL_RELATIONSHIP_PAGE_SIZE,
      };

      if (afterCursor) {
        variables.after = afterCursor;
      }

      const params = {
        query_hash: queryHash,
        variables: JSON.stringify(variables),
      };

      console.log(
        `[Instagram GraphQL] Request #${requestCount}: Fetching ${GRAPHQL_RELATIONSHIP_PAGE_SIZE} ${type}...`,
      );

      try {
        const graphqlRequestUrl = `${graphqlUrl}?${new URLSearchParams(params).toString()}`;
        const proxyUrl = proxyConfigToUrl(sessionProxyConfig);
        const httpsProxyAgent = new HttpsProxyAgent(proxyUrl);

        const responseData = await axios.get(graphqlRequestUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Cookie: cookieString,
            "X-CSRFToken": csrftoken,
            "X-Requested-With": "XMLHttpRequest",
            "X-IG-App-ID": "936619743392459",
          },
          httpsAgent: httpsProxyAgent,
          httpAgent: httpsProxyAgent,
          timeout: 30000,
        }).then((res) => res.data);


        const edgeKey =
          type === "followers" ? "edge_followed_by" : "edge_follow";
        const data = responseData?.data?.user?.[edgeKey];

        if (!data) {
          console.error(
            "[Instagram GraphQL] Invalid response structure:",
            responseData,
          );
          throw new Error(
            "Invalid GraphQL response. Session may have expired.",
          );
        }

        const edges = data.edges || [];
        const pageInfo = data.page_info;

        // Extract users from response — skip already-cached usernames so
        // usersMap.size tracks only NEW accounts toward effectiveLimit.
        const rawSampleNode = edges.find((edge) => edge?.node)?.node;
        if (!sampleFollowerLogged && rawSampleNode) {
          console.log(
            "[Instagram GraphQL] Sample raw follower node:",
            JSON.stringify(rawSampleNode, null, 2),
          );
          sampleFollowerLogged = true;
        }

        const remainingNeeded = effectiveLimit - totalProcessed;
        const batchUsers = [];

        edges.forEach((edge) => {
          const node = edge.node;
          const usernameKey = node?.username?.toLowerCase();
          if (
            node &&
            node.username &&
            !seenUsernameSet.has(usernameKey) &&
            !cachedUsernameSet.has(usernameKey) &&
            batchUsers.length < remainingNeeded
          ) {
            seenUsernameSet.add(usernameKey);
            batchUsers.push({
              id: node.id,
              username: node.username,
              full_name: node.full_name || null,
              profile_pic_url: node.profile_pic_url || null,
              is_verified: node.is_verified || false,
              is_private: node.is_private || false,
            });
          }
        });

        console.log(
          `[Instagram GraphQL] Batch #${requestCount}: ${batchUsers.length} new ${type} from GraphQL (processed=${totalProcessed}/${effectiveLimit}, cached=${_cache.count})`,
        );

        if (batchUsers.length > 0) {
          const enrichedBatch = await enrichGraphQLBatchWithInstagramAPI({
            users: batchUsers,
            cookieString,
            sessionProxyConfig,
            batchNumber: requestCount,
            relationshipType: type,
            jobId: String(__job_id || ""),
            userId: String(user_id || ""),
            processedCountBeforeBatch: totalProcessed,
          });

          const saveResult = await saveInstagramRelationshipBatch({
            enrichedUsers: enrichedBatch,
            user_id,
            folder_id,
            targetUsername,
            type,
            jobId: __job_id || null,
          });

          totalProcessed += enrichedBatch.length;
          totalInserted += saveResult.newCount;
          totalExistingLeadCache += saveResult.cachedCount;
          totalLinked += saveResult.linkedCount;

          if (GRAPHQL_RESULT_PREVIEW_LIMIT > 0) {
            const remainingUserPreview =
              GRAPHQL_RESULT_PREVIEW_LIMIT - resultUsersPreview.length;
            if (remainingUserPreview > 0) {
              resultUsersPreview.push(
                ...enrichedBatch.slice(0, remainingUserPreview),
              );
            }

            const remainingLeadPreview =
              GRAPHQL_RESULT_PREVIEW_LIMIT - resultLeadsPreview.length;
            if (remainingLeadPreview > 0) {
              resultLeadsPreview.push(
                ...saveResult.insertedLeads.slice(0, remainingLeadPreview),
              );
            }
          }

          console.log(
            `[Instagram GraphQL] Batch #${requestCount}: saved ${enrichedBatch.length} details (new=${saveResult.newCount}, existing=${saveResult.cachedCount}, linked=${saveResult.linkedCount})`,
          );

          const realtimePayload = {
            job_id: __job_id || null,
            stage: "SAVING_LEADS",
            status: "RUNNING",
            provider: "graphql",
            target_username: targetUsername,
            relationship_type: toRelationshipDirection(type),
            type,
            folder_id: folder_id || null,
            batch_number: requestCount,
            batch_count: enrichedBatch.length,
            users: enrichedBatch,
            collected_count: totalProcessed,
            saved_count: totalInserted,
            existing_lead_count: totalExistingLeadCache,
            duplicate_count: totalExistingLeadCache,
            failed_count: 0,
            linked_count: totalLinked,
            total_processed: totalProcessed,
            total_cached_before_start: _cache.count,
            total_on_profile: totalOnProfile,
            requested_limit: totalOnProfile || maxLimit || null,
            cost_spent_estimate_usd: null,
            completion_percentage: totalOnProfile
              ? (((totalProcessed + _cache.count) / totalOnProfile) * 100).toFixed(1)
              : null,
            partial: false,
          };

          const progressPayload = { ...realtimePayload };
          delete progressPayload.users;

          emitScrapeRealtime({
            userId: user_id,
            event: "scrape:batch",
            payload: realtimePayload,
          });
          emitScrapeRealtime({
            userId: user_id,
            event: "scrape:progress",
            payload: progressPayload,
          });
        }

        // Check pagination
        hasNextPage = pageInfo?.has_next_page || false;
        afterCursor = pageInfo?.end_cursor || null;

        if (!hasNextPage) {
          console.log("[Instagram GraphQL] Reached end of list");
          break;
        }

        if (totalProcessed >= effectiveLimit) {
          console.log(
            `[Instagram GraphQL] Reached limit of ${effectiveLimit} more users (effectiveLimit)`,
          );
          break;
        }

        // Cooperative pause check — worker sets __control.pauseRequested via Redis
        if (__checkPause && (await __checkPause())) {
          console.log(
            `[Instagram GraphQL] Pause requested - stopping after batch #${requestCount} (${totalProcessed} users processed)`,
          );
          hasNextPage = false;
          break;
        }

        // A short humanized gap reduces throttling without killing throughput.
        await humanDelay(1500, 3500);
      } catch (requestError) {
        if (isRateLimitError(requestError)) {
          console.error("[Instagram GraphQL] Rate limited by Instagram");
          const rateLimitError = new Error(
            "Rate limited by Instagram. Cooling account before retry.",
          );
          rateLimitError.name = "InstagramRateLimitError";
          rateLimitError.response = requestError.response;
          throw rateLimitError;
        }
        if (isAuthError(requestError)) {
          console.error("[Instagram GraphQL] Instagram rejected this session");
          const authError = new Error(
            "Instagram rejected this session. Cookies may be stale or proxy trust changed.",
          );
          authError.name = "InstagramAuthError";
          authError.response = requestError.response;
          throw authError;
        }
        throw requestError;
      }
    }

    console.log(
      `[Instagram GraphQL] Scraping completed! Total processed ${type}: ${totalProcessed}`,
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 5: Enrich Users with Apify (REUSE EXISTING LOGIC)
    // ═══════════════════════════════════════════════════════════════════════════
    /*
    Legacy end-of-scrape post-processing is intentionally disabled.
    The GraphQL path now enriches, saves, and emits each fetched page in the
    pagination loop above, which keeps memory bounded and streams results live.
    const enrichedUsers = [];
    const usersArray = Array.from(usersMap.values());

    // const enrichLimit = Math.min(effectiveLimit, ENRICH_LIMIT, usersArray.length);
    const enrichLimit = Math.min(effectiveLimit, usersArray.length);
    const usersToEnrich = usersArray.slice(0, enrichLimit);

    if (usersArray.length > enrichLimit) {
      console.log(
        `[Instagram GraphQL] ⚠️  Limiting enrichment from ${usersArray.length} to ${enrichLimit} users`,
      );
    }

    if (usersToEnrich.length > 0) {
      console.log(
        `[Instagram GraphQL] Enriching ${usersToEnrich.length} profiles using Instagram API...`,
      );

      try {
        const usernamesToEnrich = usersToEnrich.map((user) => user.username);
        const apifyBulkData = await scrapeWithInstagramAPIBulk(
          usernamesToEnrich,
          cookieString,
          {
            context: {
              jobType: type,
              jobId: job_id || null,
              userId: user_id || null,
            },
            allowSingleAsFinalLeftover: usersToEnrich.length > 1,
          },
        );

        if (apifyBulkData && apifyBulkData.length > 0) {
          const apifyMap = new Map();
          apifyBulkData.forEach((item) => {
            if (item.username) {
              apifyMap.set(item.username.toLowerCase(), item);
            }
          });

          for (const user of usersToEnrich) {
            const apifyData = apifyMap.get(user.username.toLowerCase());

            if (apifyData) {
              enrichedUsers.push({
                id: user.id,
                username: user.username,
                followers: apifyData.followersCount || null,
                following: apifyData.followsCount || null,
                bio: apifyData.biography || null,
                category: apifyData.businessCategoryName || null,
                avatar:
                  apifyData.profilePicUrl ||
                  apifyData.profilePicUrlHD ||
                  user.profile_pic_url,
                full_name: apifyData.fullName || user.full_name,
                is_verified: apifyData.verified || user.is_verified,
                is_private: apifyData.private || user.is_private,
                external_url: apifyData.externalUrl || null,
                external_urls: Array.isArray(apifyData.externalUrls)
                  ? apifyData.externalUrls
                      .map((entry) =>
                        typeof entry === "string" ? entry : entry?.url,
                      )
                      .filter(Boolean)
                  : [],
                links: Array.isArray(apifyData.externalUrls)
                  ? apifyData.externalUrls
                  : [],
                posts_count: apifyData.postsCount || null,
                raw_profile: apifyData,
              });
              console.log(
                `[Apify] ✓ Enriched @${user.username} - Followers: ${apifyData.followersCount}`,
              );
            } else {
              // Use GraphQL data as fallback
              enrichedUsers.push({
                id: user.id,
                username: user.username,
                followers: null,
                following: null,
                bio: null,
                category: null,
                avatar: user.profile_pic_url,
                full_name: user.full_name,
                is_verified: user.is_verified,
                is_private: user.is_private,
                external_url: null,
                external_urls: [],
                links: [],
                posts_count: null,
              });
              console.log(`[Apify] ⚠️  No data returned for @${user.username}`);
            }
          }
        } else {
          // Use GraphQL data only
          for (const user of usersToEnrich) {
            enrichedUsers.push({
              id: user.id,
              username: user.username,
              followers: null,
              following: null,
              bio: null,
              category: null,
              avatar: user.profile_pic_url,
              full_name: user.full_name,
              is_verified: user.is_verified,
              is_private: user.is_private,
              external_url: null,
              external_urls: [],
              links: [],
              posts_count: null,
            });
          }
        }

        console.log(
          `[Instagram GraphQL] Profile enrichment completed! Enriched ${enrichedUsers.length} profiles.`,
        );
      } catch (error) {
        console.error(`[Apify] Error enriching profiles:`, error.message);

        // Fallback: use GraphQL data only
        for (const user of usersToEnrich) {
          enrichedUsers.push({
            id: user.id,
            username: user.username,
            followers: null,
            following: null,
            bio: null,
            category: null,
            avatar: user.profile_pic_url,
            full_name: user.full_name,
            is_verified: user.is_verified,
            is_private: user.is_private,
            external_url: null,
            external_urls: [],
            links: [],
            posts_count: null,
            error: error.message,
          });
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EXTRACT EMAILS & PHONES FROM BIO + DEEP SCAN EXTERNAL URLS
    // ═══════════════════════════════════════════════════════════════════════════
    console.log(
      `[Instagram GraphQL] Extracting emails/phones from bios; external URL deep scans are queued after save...`,
    );

    for (const user of enrichedUsers) {
      Object.assign(user, applyContactSnapshotToProfile(user));

      if (user.emails.length > 0 || user.phone_numbers.length > 0) {
        console.log(
          `[Extract] @${user.username}: ${user.emails.length} email(s), ${user.phone_numbers.length} phone(s)`,
        );
      }
    }

    console.log(`[Instagram GraphQL] Email/phone extraction completed!`);

    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 6: Save to Database via bulkResolveOrCreate (dedup + UserLead)
    // ═══════════════════════════════════════════════════════════════════════════
    let insertedLeads = [];
    let reservedCredits = 0;
    let cachedCount = 0;
    if (enrichedUsers.length > 0) {
      try {
        console.log(
          `[Instagram GraphQL] Preparing ${enrichedUsers.length} leads for database insert...`,
        );

        const leadsToInsert = enrichedUsers.map((user) => {
          const { first_name, last_name } = splitName(user.full_name || "");

          return {
            first_name,
            last_name,
            company: user.username || "",
            emails: user.emails || [],
            phone_numbers: user.phone_numbers || [],
            message: `
${relationshipScrapeTitle(type)} (GraphQL)

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
Scraping Method: GraphQL API
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
            external_urls: user.external_urls || [],
            is_private: user.is_private,
            is_verified: user.is_verified,
            is_public: user.is_private !== null ? !user.is_private : null,
            fb_profile_biolink: null,
            highlight_reel_count: null,
            links: user.links || [],
            deep_scan_status:
              DEEP_SCAN_RELATIONSHIP_ENABLED &&
              Array.isArray(user.external_urls) &&
              user.external_urls.length > 0
                ? "PENDING"
                : null,
            scrape_status: true,
            type: "INSTAGRAM",
          };
        });

        reservedCredits = await reserveScrapedProfileCredits(
          user_id,
          leadsToInsert.length,
        );

        console.log(
          `[Instagram GraphQL] Inserting ${leadsToInsert.length} leads into database (with dedup)...`,
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

        insertedLeads = bulkResult.insertedLeads;
        cachedCount = bulkResult.cachedCount;

        await refundUnusedScrapedProfileCredits(
          user_id,
          reservedCredits,
          insertedLeads.length,
        );
        enqueueRelationshipDeepScans({
          user_id,
          job_id: __job_id || null,
          leads: [
            ...(insertedLeads || []),
            ...(bulkResult.cachedLeads || []),
          ],
          label: "Instagram GraphQL",
        });
        console.log(
          `[Instagram GraphQL] Done — new: ${bulkResult.newCount}, from cache: ${bulkResult.cachedCount}`,
        );
      } catch (dbError) {
        if (dbError.statusCode) {
          throw dbError;
        }
        console.error(
          "[Instagram GraphQL] Database bulk insert error:",
          dbError.message,
        );
        await refundUnusedScrapedProfileCredits(user_id, reservedCredits, 0);
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    */

    // Release Account (Success)
    // ═══════════════════════════════════════════════════════════════════════════
    if (igAccount) {
      await accountPool.releaseAccount(igAccount._id, true);
      console.log(
        `[Instagram GraphQL] Released account: @${igAccount.username} (success)`,
      );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Return Same Format as Puppeteer Scraper
    // ═══════════════════════════════════════════════════════════════════════════
    const allLeadsPreview = [
      ...(_cache.leads || []).slice(0, GRAPHQL_RESULT_PREVIEW_LIMIT),
      ...resultLeadsPreview,
    ].slice(0, GRAPHQL_RESULT_PREVIEW_LIMIT);
    const allUsersPreview = [
      ...(_cache.leads || []).slice(0, GRAPHQL_RESULT_PREVIEW_LIMIT),
      ...resultUsersPreview,
    ].slice(0, GRAPHQL_RESULT_PREVIEW_LIMIT);
    const totalAvailable = _cache.count + totalProcessed;
    return {
      code: 200,
      success: true,
      message: `${type}-scraped-successfully-graphql`,
      data: {
        target_username: targetUsername,
        type: type,
        count: totalAvailable,
        enriched_count: totalProcessed,
        cached_count: _cache.count,
        existing_lead_count: totalExistingLeadCache,
        linked_count: totalLinked,
        leads_inserted: totalInserted,
        total_on_profile: totalOnProfile,
        max_limit: maxLimit,
        missing_count: totalOnProfile
          ? Math.max(0, totalOnProfile - totalAvailable)
          : null,
        completion_percentage: totalOnProfile
          ? ((totalAvailable / totalOnProfile) * 100).toFixed(1)
          : null,
        status_message: `Scraped ${totalProcessed} ${type} details via GraphQL + web_profile_info, ${_cache.count} from cache (${totalAvailable} total)`,
        scraping_method: "GraphQL + web_profile_info streaming",
        result_preview_limit: GRAPHQL_RESULT_PREVIEW_LIMIT,
        result_truncated: totalAvailable > allUsersPreview.length,
        users: allUsersPreview,
        leads: allLeadsPreview,
      },
    };
  } catch (error) {
    console.error(`[Instagram GraphQL] Error:`, error);

    // Release account on failure
    if (igAccount) {
      const releaseReason = isRateLimitError(error)
        ? "rate_limit"
        : isAuthError(error)
          ? "auth_error"
          : "scraping_error";

      await accountPool.releaseAccount(
        igAccount._id,
        false,
        releaseReason,
      );
      console.log(
        `[Instagram GraphQL] Released account: @${igAccount.username} (failure)`,
      );
    }

    // Classify error: Apify blocked/rate-limited = high-usage, others = failed-to-analyze
    const isApifyBlocked =
      isRateLimitError(error) ||
      error.message?.includes(
        "Instagram API returned data but no user ID found",
      ) ||
      error.message?.includes("No user data returned from Instagram API") ||
      error.message?.includes("Could not fetch user ID") ||
      error.message?.includes("No Instagram accounts available");

    return {
      code: 500,
      success: false,
      message: isApifyBlocked ? "high-usage" : "failed-to-analyze",
      error: error.message,
      error_type: error.name || "UnknownError",
    };
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Main Scraper Function (Puppeteer-based with Optional GraphQL)
// ═══════════════════════════════════════════════════════════════════════════

// Scrape followers or following
const scrapeFollowersOrFollowing = async ({
  targetUsername,
  type = "followers",
  // maxLimit — intentionally removed. Target is always the real profile count
  // read from the DOM (totalCount). No artificial cap applied.
  user_id,
  folder_id,
  withGraphQl = false, // NEW: Optional GraphQL method
  provider = null,
  __checkPause,
  job_id,
}) => {
  const requestType = normalizeRelationshipRequestType(type);
  const relationshipProvider = resolveRelationshipProvider({ provider, withGraphQl });

  if (relationshipProvider === RELATIONSHIP_PROVIDER_TYPES.APIFY) {
    const unsupported = new ProviderUnsupportedOperationError(
      "provider-unsupported-relationship-type",
      {
        provider: RELATIONSHIP_PROVIDER_TYPES.APIFY,
        metadata: { type: requestType },
      },
    );

    return {
      code: 400,
      success: false,
      message: "provider 'apify' is currently not supported for followers/following scraping",
      error: unsupported.message,
      error_type: unsupported.name,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GRAPHQL METHOD ROUTING - Use GraphQL API if flag is enabled
  // ═══════════════════════════════════════════════════════════════════════════
  if (relationshipProvider === RELATIONSHIP_PROVIDER_TYPES.GRAPHQL) {
    console.log(
      "[Instagram] Using GraphQL scraping method (faster, lower memory)",
    );
    return await scrapeFollowersOrFollowingGraphQL({
      targetUsername,
      type: requestType,
      maxLimit: Number.MAX_SAFE_INTEGER, // scrape all; GraphQL fn uses totalOnProfile
      user_id,
      folder_id,
      __checkPause,
      __job_id: job_id,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DATABASE LOOKUP DISABLED - Scrape fresh every time, no cache check.
  // Duplicate prevention is handled at DB insert (bulkResolveOrCreate).
  // ═══════════════════════════════════════════════════════════════════════════
  // const _relType = type === "followers" ? "follower" : "following";
  // let _cache = { count: 0, leads: [] };
  // try {
  //   _cache = await userLeadService.getExistingFollowersForTarget(
  //     user_id, targetUsername, _relType,
  //   );
  // } catch (cacheErr) {
  //   console.warn(`[Instagram] Cache lookup failed (non-fatal): ${cacheErr.message}`);
  // }
  // Preliminary early-return removed — always do a fresh scrape.
  // const cachedUsernameSet removed — we don't skip already-saved usernames.
  const _cache = { count: 0, leads: [] };
  const cachedUsernameSet = new Set(); // empty: accept all scraped users

  // ═══════════════════════════════════════════════════════════════════════════
  // PUPPETEER METHOD (DEFAULT) - Original implementation unchanged
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("[Instagram] Using Puppeteer scraping method (default)");

  type = requestType;

  if (!targetUsername) {
    return {
      code: 400,
      success: false,
      message: "targetUsername is required",
    };
  }

  let browser;
  let igAccount = null; // Track account from pool
  let relationshipLockKey = null;

  try {
    // ═══════════════════════════════════════════════════════════════════════════
    // CONCURRENCY CHECK - Prevent multiple scrapers running simultaneously
    // ═══════════════════════════════════════════════════════════════════════════
    const lock = acquireRelationshipLock({
      jobId: job_id,
      userId: user_id,
      targetUsername,
      type,
      provider: relationshipProvider,
    });
    relationshipLockKey = lock.lockKey;

    if (!lock.acquired) {
      console.error(`[Instagram] Relationship scrape already running: ${relationshipLockKey}`);
      return {
        code: 429,
        success: false,
        message: "relationship-scrape-already-running",
        error: "An identical relationship scrape is already in progress.",
      };
    }

    console.log(`[Instagram] Relationship lock acquired: ${relationshipLockKey}`);

    console.log(`[Instagram] Starting ${type} scraper for @${targetUsername}`);

    // Select account from pool
    console.log("[Instagram] Selecting account from pool...");
    let igAccount = await accountPool.getNextAccount(user_id);
    console.log(`[Instagram] Using account: @${igAccount.username}`);

    // Track memory usage throughout the operation
    const memTracker = new MemoryTracker(`Scrape ${type}`);
    logMemoryUsage("Initial");

    // ═══════════════════════════════════════════════════════════════════════════
    // PROXY INTEGRATION - One proxy per session (no mid-session rotation)
    // ═══════════════════════════════════════════════════════════════════════════
    const proxyConfig = getNextProxyConfig();
    const proxyServer = `${proxyConfig.host}:${proxyConfig.port}`;
    console.log(`[Instagram] Using proxy: ${proxyServer} (hiding credentials)`);

    browser = await puppeteer.launch({
      headless: "new", // NEW headless mode for stealth + performance (EC2 safe)
      args: [
        // ═══════════════════════════════════════════════════════════════════════════
        // PROXY SERVER - Critical for IP reputation management
        // ═══════════════════════════════════════════════════════════════════════════
        `--proxy-server=${proxyServer}`,

        // Essential security flags
        "--no-sandbox",
        "--disable-setuid-sandbox",

        // Memory optimizations (EC2 micro safe - 1GB RAM)
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--disable-translate",
        "--mute-audio",
        "--no-first-run",
        "--disable-default-apps",
        "--disable-software-rasterizer",

        // Stealth & anti-detection
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
      ],
      // Increase timeout for slower systems
      timeout: 60000,
      // Prevent premature closure
      dumpio: false,
      // Handle process crashes gracefully
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });

    const page = await browser.newPage();

    memTracker.checkpoint("Browser launched");

    // ═══════════════════════════════════════════════════════════════════════════
    // PROXY AUTHENTICATION - Handle proxy credentials
    // ═══════════════════════════════════════════════════════════════════════════
    await page.authenticate({
      username: proxyConfig.username,
      password: proxyConfig.password,
    });
    console.log("[Instagram] Proxy authentication configured");

    // Block only large resources to save memory (keep essentials for Instagram)
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const resourceType = request.resourceType();
      // Only block images and media - Instagram needs CSS/fonts to function
      if (["image", "media"].includes(resourceType)) {
        request.abort();
      } else {
        request.continue();
      }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // STEALTH & ANTI-DETECTION CONFIGURATION
    // ═══════════════════════════════════════════════════════════════════════════

    // Realistic user agent (Chrome on Windows)
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );

    // Hide automation indicators (critical for stealth)
    await page.evaluateOnNewDocument(() => {
      // Remove webdriver property
      Object.defineProperty(navigator, "webdriver", {
        get: () => undefined,
      });

      // Override permissions API
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) =>
        parameters.name === "notifications"
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters);

      // Add realistic plugins
      Object.defineProperty(navigator, "plugins", {
        get: () => [1, 2, 3, 4, 5],
      });

      // Add realistic languages
      Object.defineProperty(navigator, "languages", {
        get: () => ["en-US", "en"],
      });
    });

    // Realistic viewport (standard desktop resolution)
    await page.setViewport({
      width: 1366,
      height: 768,
      deviceScaleFactor: 1,
    });

    // Disable cache for memory efficiency (EC2 micro safe)
    await page.setCacheEnabled(false);

    // Load cookies from account pool
    const accountCookies = igAccount.getCookies();
    console.log(
      `[Instagram] Loaded ${accountCookies.length} cookies from account pool`,
    );
    if (accountCookies && accountCookies.length > 0) {
      await page.setCookie(...accountCookies);
      console.log(
        `[Instagram] Applied ${accountCookies.length} cookies to browser`,
      );
    }

    // Navigate to Instagram homepage
    console.log("[Instagram] Navigating to Instagram...");
    await page.goto("https://www.instagram.com/", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });
    await pageLoadDelay();

    // Give extra time for page to fully render
    await humanDelay(2000, 3000);

    // Check if logged in
    console.log("[Instagram] Checking login status...");
    let loggedIn = await isLoggedIn(page);

    if (!loggedIn) {
      console.log("[Instagram] Not logged in, proceeding to login...");
      await loginToInstagram(page);
      // Note: Cookies managed by account pool, not saved to file

      // Verify login was successful
      await humanDelay(2000, 3000);
      loggedIn = await isLoggedIn(page);

      if (!loggedIn) {
        throw new Error(
          "Login failed - still not logged in after login attempt",
        );
      }

      console.log("[Instagram] Login verified successfully!");
    } else {
      console.log("[Instagram] Already logged in!");
    }

    // Navigate to target profile
    console.log(`[Instagram] Navigating to @${targetUsername} profile...`);
    await page.goto(`https://www.instagram.com/${targetUsername}/`, {
      waitUntil: "networkidle2",
      timeout: 30000,
    });
    await pageLoadDelay();

    // Check if login dialog appeared on the profile page
    const profileLoginDialog = await page.evaluate(() => {
      const dialogs = document.querySelectorAll('div[role="dialog"]');
      for (const dialog of dialogs) {
        if (
          dialog.textContent.includes("Log in") ||
          dialog.textContent.includes("Sign up for Instagram")
        ) {
          return true;
        }
      }
      return false;
    });

    if (profileLoginDialog) {
      console.log(
        "[Instagram] Login dialog appeared on profile - session expired, clicking 'Log in' button...",
      );

      // Click the "Log in" button in the modal to navigate to login page
      const loginButtonClicked = await page.evaluate(() => {
        const buttons = Array.from(
          document.querySelectorAll('[role="button"]'),
        );
        const loginBtn = buttons.find(
          (btn) =>
            btn.textContent.trim() === "Log in" ||
            btn.textContent.trim() === "Log In",
        );
        if (loginBtn) {
          loginBtn.click();
          console.log('[Instagram] Clicked "Log in" button in modal');
          return true;
        }
        return false;
      });

      if (loginButtonClicked) {
        console.log("[Instagram] Waiting for login page to load...");
        await humanDelay(2000, 3000);
      }

      // Session expired - perform fresh login
      await loginToInstagram(page);
      console.log("[Instagram] Login completed, saving cookies...");

      // Save updated cookies to file after successful login
      const updatedCookies = await page.cookies();
      const cookiesPath = path.resolve(
        process.cwd(),
        "storage",
        "cookies.json",
      );
      fs.writeFileSync(cookiesPath, JSON.stringify(updatedCookies, null, 2));
      console.log(
        `[Instagram] Saved ${updatedCookies.length} cookies to ${cookiesPath}`,
      );

      // Navigate to profile again with fresh session
      console.log(`[Instagram] Re-navigating to @${targetUsername} profile...`);
      await page.goto(`https://www.instagram.com/${targetUsername}/`, {
        waitUntil: "networkidle2",
        timeout: 30000,
      });
      await pageLoadDelay();
    }

    // Stay on profile to look human
    console.log("[Instagram] Viewing profile...");
    await humanDelay(2000, 4000);

    // Extract total follower/following count from profile before opening modal
    const totalCount = await page.evaluate((type) => {
      try {
        // Find all links on the page
        const links = Array.from(document.querySelectorAll("a"));

        // Find the followers or following link
        const targetLink = links.find((a) => a.href.includes(`/${type}/`));

        if (targetLink) {
          // Look for the count in the link's text content
          // Format is usually like "69 followers" or "39 following"
          const text = targetLink.textContent;
          const match = text.match(/([\d,]+)\s*(follower|following)/i);

          if (match) {
            // Remove commas and parse as integer
            const count = parseInt(match[1].replace(/,/g, ""), 10);
            return count;
          }
        }

        // Fallback: try to find in meta tags or other elements
        const metaContent = document.querySelector(
          'meta[property="og:description"]',
        );
        if (metaContent) {
          const content = metaContent.getAttribute("content");
          const regex =
            type === "followers" ? /(\d+) Followers/ : /(\d+) Following/;
          const match = content.match(regex);
          if (match) {
            return parseInt(match[1].replace(/,/g, ""), 10);
          }
        }
      } catch (e) {
        console.error("[Instagram] Error extracting total count:", e);
      }
      return null;
    }, type);

    if (totalCount) {
      console.log(
        `[Instagram] Profile has ${totalCount} ${type} — this is the scrape target`,
      );
    } else {
      console.log(
        `[Instagram] Could not determine total ${type} count from DOM. Will scroll until no more users are found.`,
      );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CACHE DECISION + SAFE LIMIT DISABLED — scrape all followers/following.
    // Duplicate records are prevented at DB insert via bulkResolveOrCreate.
    // ═══════════════════════════════════════════════════════════════════════════
    // const _cacheThreshold = ...
    // if (_cache.count >= _cacheThreshold) { return cached; }
    // const effectiveLimit = ...
    // const targetScrapCount = Math.min(effectiveLimit, SAFE_SCRAPE_LIMIT);

    // Scrape exactly the totalCount read from the profile DOM.
    // If the DOM count was unavailable, scroll until Instagram stops loading more.
    const targetScrapCount = totalCount ?? Number.MAX_SAFE_INTEGER;
    const effectiveLimit = targetScrapCount;
    console.log(
      `[Instagram] Scrape target: ${totalCount != null ? totalCount + " (from profile DOM)" : "unlimited — scroll until exhausted"}`,
    );

    // Click on followers or following
    console.log(`[Instagram] Clicking on ${type}...`);
    const linkText = type === "followers" ? "followers" : "following";

    await page.evaluate((text) => {
      const links = Array.from(document.querySelectorAll("a"));
      const link = links.find((a) => a.href.includes(`/${text}/`));
      if (link) link.click();
    }, linkText);

    await humanDelay(2000, 3000);

    // Wait for modal/dialog to appear
    console.log(`[Instagram] Waiting for ${type} dialog...`);
    await page.waitForSelector('div[role="dialog"]', { timeout: 10000 });

    // Wait longer for initial content to load
    console.log(`[Instagram] Waiting for initial content to load...`);
    await humanDelay(3000, 4000);

    // Scroll and collect followers/following
    console.log(`[Instagram] Scrolling through ${type}...`);
    memTracker.checkpoint("Starting scroll collection");

    const usersMap = new Map(); // Use Map to avoid duplicates, keyed by username
    let previousCount = 0;
    let stagnantScrolls = 0;
    const maxStagnantScrolls = 3; // Maximum stagnant scrolls before giving up
    let scrollAttempts = 0;
    let consecutiveBottomHits = 0;
    let lastDomCleanup = 0; // Track last DOM cleanup

    while (
      usersMap.size < targetScrapCount &&
      stagnantScrolls < maxStagnantScrolls
    ) {
      // ═══════════════════════════════════════════════════════════════════════════
      // PERIODIC DOM CLEANUP - Prevent memory leaks during long scrolling sessions
      // ═══════════════════════════════════════════════════════════════════════════
      if (scrollAttempts - lastDomCleanup >= 20) {
        try {
          await page.evaluate(() => {
            const dialog = document.querySelector('div[role="dialog"]');
            if (dialog) {
              // Force DOM re-render to release memory
              const scrollTop = dialog.querySelector("div")?.scrollTop || 0;
              dialog.innerHTML = dialog.innerHTML;
              // Restore scroll position
              const scrollableDiv = Array.from(
                dialog.querySelectorAll("div"),
              ).find((div) => {
                const style = window.getComputedStyle(div);
                return (
                  (style.overflow === "auto" || style.overflowY === "auto") &&
                  div.scrollHeight > div.clientHeight
                );
              });
              if (scrollableDiv) scrollableDiv.scrollTop = scrollTop;
            }
          });
          lastDomCleanup = scrollAttempts;
          console.log(
            `[Instagram] 🧹 DOM cleanup performed at scroll #${scrollAttempts}`,
          );
        } catch (cleanupError) {
          console.log(
            `[Instagram] DOM cleanup failed (non-critical): ${cleanupError.message}`,
          );
        }
      }
      // Extract user data from current view
      const currentUsers = await page.evaluate(() => {
        const dialog = document.querySelector('div[role="dialog"]');
        if (!dialog) return [];

        const userElements = [];

        // Find all user profile links in the dialog
        const links = Array.from(dialog.querySelectorAll('a[href^="/"]'));

        for (const link of links) {
          const href = link.getAttribute("href");

          // Filter out non-profile links (posts, reels, etc.)
          if (
            href &&
            href.startsWith("/") &&
            !href.includes("/p/") &&
            !href.includes("/reel/") &&
            !href.includes("/explore/") &&
            !href.includes("/accounts/")
          ) {
            const username = href
              .replace(/^\//, "")
              .replace(/\/$/, "")
              .split("/")[0];

            if (!username) continue;

            // Try to extract user ID from various possible locations
            let userId = null;

            // Method 1: Check for data-id or data-userid attributes
            userId =
              link.getAttribute("data-id") || link.getAttribute("data-userid");

            // Method 2: Look for user ID in parent container
            if (!userId) {
              const parent = link.closest('[data-testid], [role="button"]');
              if (parent) {
                userId =
                  parent.getAttribute("data-id") ||
                  parent.getAttribute("data-userid");
              }
            }

            // Method 3: Try to find it in onclick or other attributes
            if (!userId) {
              const allAttributes = link.getAttributeNames();
              for (const attr of allAttributes) {
                const value = link.getAttribute(attr);
                if (value && /^\d+$/.test(value) && value.length > 5) {
                  userId = value;
                  break;
                }
              }
            }

            // If still no ID, generate a placeholder (username can be used as unique identifier)
            if (!userId) {
              userId = username; // Fallback to username
            }

            userElements.push({
              id: userId,
              username: username,
            });
          }
        }

        // Remove duplicates based on username
        const uniqueUsers = {};
        userElements.forEach((user) => {
          if (!uniqueUsers[user.username]) {
            uniqueUsers[user.username] = user;
          }
        });

        return Object.values(uniqueUsers);
      });

      // Add new users to map — skip already-cached usernames so usersMap.size
      // tracks only NEW accounts toward effectiveLimit.
      currentUsers.forEach((user) => {
        if (
          !usersMap.has(user.username) &&
          !cachedUsernameSet.has(user.username.toLowerCase())
        ) {
          usersMap.set(user.username, user);
        }
      });

      console.log(
        `[Instagram] Collected ${usersMap.size} new users so far (need ${effectiveLimit}, cached ${_cache.count} already)...${totalCount ? ` (total on profile: ${totalCount})` : ""}`,
      );

      // Check if we're still finding new users
      if (usersMap.size === previousCount) {
        stagnantScrolls++;

        // Special handling: if we're close to the known total (>90%), keep trying harder
        if (totalCount && usersMap.size > totalCount * 0.9) {
          console.log(
            `[Instagram] Very close to total (${usersMap.size}/${totalCount}), stagnant: ${stagnantScrolls}/${maxStagnantScrolls}`,
          );
        } else {
          console.log(
            `[Instagram] No new users found. Stagnant scrolls: ${stagnantScrolls}/${maxStagnantScrolls}`,
          );
        }
      } else {
        stagnantScrolls = 0;
        console.log(
          `[Instagram] Found ${usersMap.size - previousCount} new users!`,
        );
      }
      previousCount = usersMap.size;

      // If we have enough NEW users, stop scrolling
      if (usersMap.size >= targetScrapCount) {
        console.log(
          `[Instagram] Reached target of ${targetScrapCount} new users`,
        );
        break;
      }

      // Scroll gently like human with small increments
      scrollAttempts++;
      const scrollIncrement = Math.floor(Math.random() * 250) + 150; // 150-400px per scroll (gentle)

      const scrollResult = await page.evaluate((scrollAmount) => {
        const dialog = document.querySelector('div[role="dialog"]');
        if (!dialog) return { scrolled: false, reachedBottom: false };

        // Find the scrollable div (usually has overflow: auto/scroll)
        const scrollableDivs = Array.from(
          dialog.querySelectorAll("div"),
        ).filter((div) => {
          const style = window.getComputedStyle(div);
          return (
            (style.overflow === "auto" ||
              style.overflow === "scroll" ||
              style.overflowY === "auto" ||
              style.overflowY === "scroll") &&
            div.scrollHeight > div.clientHeight
          ); // Must be actually scrollable
        });

        if (scrollableDivs.length > 0) {
          const scrollableDiv = scrollableDivs[0];
          const beforeScroll = scrollableDiv.scrollTop;
          const beforeHeight = scrollableDiv.scrollHeight;

          scrollableDiv.scrollTop += scrollAmount;

          const afterScroll = scrollableDiv.scrollTop;

          // Check if we've reached the bottom
          const isAtBottom =
            scrollableDiv.scrollTop + scrollableDiv.clientHeight >=
            scrollableDiv.scrollHeight - 50;

          // If at bottom, force scroll to absolute end to trigger loading
          if (isAtBottom) {
            scrollableDiv.scrollTop = scrollableDiv.scrollHeight;
          }

          return {
            scrolled: afterScroll > beforeScroll,
            reachedBottom: isAtBottom,
            scrollTop: scrollableDiv.scrollTop,
            scrollHeight: scrollableDiv.scrollHeight,
            clientHeight: scrollableDiv.clientHeight,
            heightChanged: scrollableDiv.scrollHeight > beforeHeight,
          };
        }

        return { scrolled: false, reachedBottom: false };
      }, scrollIncrement);

      console.log(
        `[Instagram] Scroll #${scrollAttempts}: ${scrollResult.scrollTop}/${scrollResult.scrollHeight} (${scrollResult.clientHeight}px visible)${scrollResult.heightChanged ? " - NEW CONTENT LOADED!" : ""}`,
      );

      if (scrollResult.reachedBottom) {
        consecutiveBottomHits++;
        console.log(
          `[Instagram] Reached bottom (${consecutiveBottomHits}x), waiting longer for more content to load...`,
        );

        // If we've hit bottom multiple times and still missing users, try scroll-up trick
        if (
          consecutiveBottomHits >= 2 &&
          totalCount &&
          usersMap.size < totalCount
        ) {
          console.log(
            `[Instagram] Trying scroll-up-down technique to trigger loading...`,
          );
          await page.evaluate(() => {
            const dialog = document.querySelector('div[role="dialog"]');
            if (dialog) {
              const scrollableDiv = Array.from(
                dialog.querySelectorAll("div"),
              ).find((div) => {
                const style = window.getComputedStyle(div);
                return (
                  (style.overflow === "auto" ||
                    style.overflow === "scroll" ||
                    style.overflowY === "auto" ||
                    style.overflowY === "scroll") &&
                  div.scrollHeight > div.clientHeight
                );
              });
              if (scrollableDiv) {
                // Scroll up a bit
                scrollableDiv.scrollTop -= 300;
              }
            }
          });
          await humanDelay(1000, 2000);
          // Scroll back to bottom
          await page.evaluate(() => {
            const dialog = document.querySelector('div[role="dialog"]');
            if (dialog) {
              const scrollableDiv = Array.from(
                dialog.querySelectorAll("div"),
              ).find((div) => {
                const style = window.getComputedStyle(div);
                return (
                  (style.overflow === "auto" ||
                    style.overflow === "scroll" ||
                    style.overflowY === "auto" ||
                    style.overflowY === "scroll") &&
                  div.scrollHeight > div.clientHeight
                );
              });
              if (scrollableDiv) {
                scrollableDiv.scrollTop = scrollableDiv.scrollHeight;
              }
            }
          });
        }

        // Wait much longer when at bottom to allow Instagram to load more content
        await humanDelay(5000, 7000);
      } else {
        consecutiveBottomHits = 0; // Reset counter if we can still scroll
        // Normal wait after scrolling
        await humanDelay(2500, 4000);
      }
    }

    console.log(
      `[Instagram] Scraping completed! Total ${type}: ${usersMap.size}${totalCount ? ` out of ${totalCount}` : ""}`,
    );

    memTracker.checkpoint("Scraping completed");
    logMemoryUsage("After scraping");

    // Scroll back to top gently to review
    console.log(`[Instagram] Scrolling back to top to review...`);
    try {
      const scrollSteps = 10; // Number of steps to scroll back up
      for (let i = 0; i < scrollSteps; i++) {
        await page.evaluate(() => {
          const dialog = document.querySelector('div[role="dialog"]');
          if (dialog) {
            const scrollableDiv = Array.from(
              dialog.querySelectorAll("div"),
            ).find((div) => {
              const style = window.getComputedStyle(div);
              return (
                (style.overflow === "auto" ||
                  style.overflow === "scroll" ||
                  style.overflowY === "auto" ||
                  style.overflowY === "scroll") &&
                div.scrollHeight > div.clientHeight
              );
            });
            if (scrollableDiv) {
              // Scroll up gradually
              const scrollUpAmount = scrollableDiv.scrollTop / 10;
              scrollableDiv.scrollTop -= scrollUpAmount;
              return scrollableDiv.scrollTop;
            }
          }
          return 0;
        });
        await humanDelay(300, 500); // Gentle delay between scroll steps
      }

      // Final scroll to absolute top
      await page.evaluate(() => {
        const dialog = document.querySelector('div[role="dialog"]');
        if (dialog) {
          const scrollableDiv = Array.from(dialog.querySelectorAll("div")).find(
            (div) => {
              const style = window.getComputedStyle(div);
              return (
                (style.overflow === "auto" ||
                  style.overflow === "scroll" ||
                  style.overflowY === "auto" ||
                  style.overflowY === "scroll") &&
                div.scrollHeight > div.clientHeight
              );
            },
          );
          if (scrollableDiv) {
            scrollableDiv.scrollTop = 0;
          }
        }
      });

      console.log(`[Instagram] Scrolled back to top`);
      await humanDelay(1000, 2000);
    } catch (error) {
      console.log(`[Instagram] Could not scroll back to top:`, error.message);
    }

    // Report what wasn't scraped
    let missingInfo = "";
    if (totalCount && usersMap.size < totalCount) {
      const missing = totalCount - usersMap.size;
      const percentage = ((usersMap.size / totalCount) * 100).toFixed(1);
      missingInfo = `Missing ${missing} ${type} (${percentage}% scraped). Instagram may have rate-limited or some users weren't loaded.`;
      console.log(`[Instagram] ⚠️  ${missingInfo}`);
    } else if (totalCount && usersMap.size >= totalCount) {
      missingInfo = `All ${type} successfully scraped!`;
      console.log(`[Instagram] ✓ ${missingInfo}`);
    } else {
      missingInfo = `Scraped ${usersMap.size} ${type} (total count unknown)`;
      console.log(`[Instagram] ℹ️  ${missingInfo}`);
    }

    // Close the modal
    console.log(`[Instagram] Closing ${type} modal...`);
    try {
      await page.evaluate(() => {
        const closeButtons = Array.from(
          document.querySelectorAll('svg[aria-label="Close"]'),
        );
        if (closeButtons.length > 0) {
          const closeBtn =
            closeButtons[closeButtons.length - 1].closest('[role="button"]');
          if (closeBtn) {
            closeBtn.click();
            return true;
          }
        }
        return false;
      });
      await humanDelay(1000, 2000);
    } catch (error) {
      console.log(`[Instagram] Could not close modal:`, error.message);
    }

    // Aggressive cleanup before closing browser
    try {
      // Close all pages except the main one
      const pages = await browser.pages();
      for (let i = 1; i < pages.length; i++) {
        await pages[i].close();
      }

      // Clear page resources
      await page.evaluate(() => {
        // Clear session storage
        try {
          sessionStorage.clear();
        } catch (e) {}
        // Clear local storage
        try {
          localStorage.clear();
        } catch (e) {}
      });

      // Close the page
      await page.close();
    } catch (cleanupError) {
      console.log(`[Instagram] Cleanup warning:`, cleanupError.message);
    }

    // Close browser
    await browser.close();
    console.log(
      `[Instagram] Browser closed and memory cleaned, now enriching profiles with Apify...`,
    );

    // Force garbage collection if available (requires --expose-gc flag)
    if (global.gc) {
      global.gc();
      console.log(`[Instagram] Garbage collection triggered`);
    }

    memTracker.checkpoint("Browser closed");
    logMemoryUsage("After cleanup");

    // Enrich user data using Apify bulk scraping
    const enrichedUsers = [];
    const usersArray = Array.from(usersMap.values());

    // ═══════════════════════════════════════════════════════════════════════════
    // LIMIT ENRICHMENT BATCH - Protect API limits and memory usage
    // ═══════════════════════════════════════════════════════════════════════════
    const enrichLimit = Math.min(
      effectiveLimit,
      ENRICH_LIMIT,
      usersArray.length,
    );
    const usersToEnrich = usersArray.slice(0, enrichLimit);

    if (usersArray.length > enrichLimit) {
      console.log(
        `[Instagram] ⚠️  Limiting enrichment from ${usersArray.length} to ${enrichLimit} users`,
      );
    }

    if (usersToEnrich.length > 0) {
      console.log(
        `[Instagram] Enriching ${usersToEnrich.length} profiles using Instagram API...`,
      );

      try {
        // Extract usernames from users to enrich
        const usernamesToEnrich = usersToEnrich.map((user) => user.username);

        // Use Instagram JSON API bulk
        const apifyBulkData = await scrapeWithInstagramAPIBulk(
          usernamesToEnrich,
          cookieString,
        );

        // Map Apify results back to our users
        if (apifyBulkData && apifyBulkData.length > 0) {
          const apifyMap = new Map();
          apifyBulkData.forEach((item) => {
            if (item.username) {
              apifyMap.set(item.username.toLowerCase(), item);
            }
          });

          // Merge Apify data with our collected users
          for (const user of usersToEnrich) {
            const apifyData = apifyMap.get(user.username.toLowerCase());

            if (apifyData) {
              enrichedUsers.push({
                id: user.id,
                username: user.username,
                followers: apifyData.followersCount || null,
                following: apifyData.followsCount || null,
                bio: apifyData.biography || null,
                category: apifyData.businessCategoryName || null,
                avatar:
                  apifyData.profilePicUrl || apifyData.profilePicUrlHD || null,
                full_name: apifyData.fullName || null,
                is_verified: apifyData.verified || false,
                is_private: apifyData.private || false,
                external_url: apifyData.externalUrl || null,
                external_urls: Array.isArray(apifyData.externalUrls)
                  ? apifyData.externalUrls
                      .map((entry) =>
                        typeof entry === "string" ? entry : entry?.url,
                      )
                      .filter(Boolean)
                  : [],
                links: Array.isArray(apifyData.externalUrls)
                  ? apifyData.externalUrls
                  : [],
                posts_count: apifyData.postsCount || null,
                raw_profile: apifyData,
              });
              console.log(
                `[Apify] ✓ Enriched @${user.username} - Followers: ${apifyData.followersCount}`,
              );
            } else {
              // User not found in Apify results
              enrichedUsers.push({
                id: user.id,
                username: user.username,
                followers: null,
                following: null,
                bio: null,
                category: null,
                avatar: null,
                full_name: null,
                is_verified: false,
                is_private: false,
                external_url: null,
                external_urls: [],
                links: [],
                posts_count: null,
              });
              console.log(`[Apify] ⚠️  No data returned for @${user.username}`);
            }
          }
        } else {
          console.log(
            `[Apify] ⚠️  No data returned from Apify, returning basic user data`,
          );
          // Return basic user data if Apify fails
          for (const user of usersToEnrich) {
            enrichedUsers.push({
              id: user.id,
              username: user.username,
              followers: null,
              following: null,
              bio: null,
              category: null,
              avatar: null,
              full_name: null,
              is_verified: false,
              is_private: false,
              external_url: null,
              external_urls: [],
              links: [],
              posts_count: null,
            });
          }
        }

        console.log(
          `[Instagram] Profile enrichment completed! Enriched ${enrichedUsers.length} profiles.`,
        );

        memTracker.checkpoint("Apify enrichment done");
      } catch (error) {
        console.error(`[Apify] Error enriching profiles:`, error.message);

        // Fallback: return basic user data if Apify fails
        for (const user of usersToEnrich) {
          enrichedUsers.push({
            id: user.id,
            username: user.username,
            followers: null,
            following: null,
            bio: null,
            category: null,
            avatar: null,
            full_name: null,
            is_verified: false,
            is_private: false,
            external_url: null,
            external_urls: [],
            links: [],
            posts_count: null,
            error: error.message,
          });
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EXTRACT EMAILS & PHONES FROM BIO + DEEP SCAN EXTERNAL URLS
    // ═══════════════════════════════════════════════════════════════════════════
    console.log(
      `[Instagram] Extracting emails/phones from bios; external URL deep scans are queued after save...`,
    );

    let deepScanCount = 0;
    const deepScanTotal = enrichedUsers.filter(
      (user) => applyContactSnapshotToProfile(user).external_urls.length > 0,
    ).length;

    for (const user of enrichedUsers) {
      Object.assign(user, applyContactSnapshotToProfile(user));

      if (user.emails.length > 0 || user.phone_numbers.length > 0) {
        console.log(
          `[Extract] @${user.username}: ${user.emails.length} email(s), ${user.phone_numbers.length} phone(s)`,
        );
      }
    }

    console.log(`[Instagram] Email/phone extraction completed!`);
    memTracker.checkpoint("Email/phone extraction done");

    // Save enriched users to database via bulkResolveOrCreate (dedup + UserLead)
    let insertedLeads = [];
    let reservedCredits = 0;
    let cachedCount = 0;
    if (enrichedUsers.length > 0) {
      try {
        console.log(
          `[Instagram] Preparing ${enrichedUsers.length} leads for database insert...`,
        );

        const leadsToInsert = enrichedUsers.map((user) => {
          const { first_name, last_name } = splitName(user.full_name || "");

          return {
            first_name,
            last_name,
            company: user.username || "",
            emails: user.emails || [],
            phone_numbers: user.phone_numbers || [],
            message: `
${relationshipScrapeTitle(type)}

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
            external_urls: user.external_urls || [],
            is_private: user.is_private,
            is_verified: user.is_verified,
            is_public: user.is_private !== null ? !user.is_private : null,
            fb_profile_biolink: null,
            highlight_reel_count: null,
            links: user.links || [],
            deep_scan_status:
              DEEP_SCAN_RELATIONSHIP_ENABLED &&
              Array.isArray(user.external_urls) &&
              user.external_urls.length > 0
                ? "PENDING"
                : null,
            scrape_status: true,
            type: "INSTAGRAM",
          };
        });

        reservedCredits = await reserveScrapedProfileCredits(
          user_id,
          leadsToInsert.length,
        );

        console.log(
          `[Instagram] Inserting ${leadsToInsert.length} leads into database (with dedup)...`,
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

        insertedLeads = bulkResult.insertedLeads;
        cachedCount = bulkResult.cachedCount;

        await refundUnusedScrapedProfileCredits(
          user_id,
          reservedCredits,
          insertedLeads.length,
        );
        enqueueRelationshipDeepScans({
          user_id,
          job_id,
          leads: [
            ...(insertedLeads || []),
            ...(bulkResult.cachedLeads || []),
          ],
          label: "Instagram Puppeteer",
        });
        console.log(
          `[Instagram] Done — new: ${bulkResult.newCount}, from cache: ${bulkResult.cachedCount}`,
        );
        memTracker.checkpoint("Database insert complete");

        // ─── Real-time WebSocket update ───────────────────────────────────────
        // Emit a progress event to the user's socket room so the frontend table
        // can refresh and show the live saved count.
        try {
          const io = getIO();
          io.to(`user:${user_id}`).emit("scrape:progress", {
            event: "scrape:progress",
            job_id,
            stage: "SAVING_LEADS",
            status: "RUNNING",
            provider: "puppeteer",
            user_id,
            target_username: targetUsername,
            relationship_type: toRelationshipDirection(type),
            type,
            collected_count: enrichedUsers.length,
            saved_count: insertedLeads.length,
            duplicate_count: cachedCount,
            failed_count: 0,
            total_scraped: enrichedUsers.length,
            total_on_profile: totalCount || null,
            deep_scan_count: deepScanCount,
            deep_scan_total: deepScanTotal,
            requested_limit: totalCount || null,
            cost_spent_estimate_usd: null,
            partial: false,
            folder_id: folder_id || null,
            ts: Date.now(),
          });
        } catch (wsErr) {
          // WebSocket not critical — log and continue
          console.warn(
            `[Instagram] WebSocket emit failed (non-fatal): ${wsErr.message}`,
          );
        }
      } catch (dbError) {
        if (dbError.statusCode) {
          throw dbError;
        }
        console.error(
          "[Instagram] Database bulk insert error:",
          dbError.message,
        );
        await refundUnusedScrapedProfileCredits(user_id, reservedCredits, 0);
      }
    }

    // Final memory summary
    memTracker.summary();
    logMemoryUsage("Final");

    // ═══════════════════════════════════════════════════════════════════════════
    // RELEASE CONCURRENCY LOCK (SUCCESS PATH)
    // ═══════════════════════════════════════════════════════════════════════════
    releaseRelationshipLock(relationshipLockKey);
    relationshipLockKey = null;
    console.log("[Instagram] Relationship lock released (success)");

    // Release account back to pool (success)
    if (igAccount) {
      await accountPool.releaseAccount(igAccount._id, true);
      console.log(
        `[Instagram] Account @${igAccount.username} released successfully`,
      );
    }

    const allLeads = [...insertedLeads];
    const allUsers = [...enrichedUsers];
    return {
      code: 200,
      success: true,
      message: `${type}-scraped-successfully`,
      data: {
        target_username: targetUsername,
        type: type,
        count: allLeads.length,
        enriched_count: allUsers.length,
        leads_inserted: insertedLeads.length,
        cached_count: _cache.count,
        total_on_profile: totalCount || null,
        scrape_target: totalCount || null,
        missing_count: totalCount
          ? Math.max(0, totalCount - allLeads.length)
          : null,
        completion_percentage: totalCount
          ? ((allLeads.length / totalCount) * 100).toFixed(1)
          : null,
        status_message: `Scraped ${insertedLeads.length} new ${type} out of ${totalCount ?? "unknown"} on profile (${allLeads.length} saved total)`,
        users: allUsers,
        leads: allLeads,
      },
    };
  } catch (error) {
    console.error(`[Instagram] Error:`, error);

    // Better error logging for debugging
    if (
      error.name === "TargetCloseError" ||
      error.message.includes("Target closed")
    ) {
      console.error(
        "[Instagram] Browser crashed on launch. This may be due to:",
      );
      console.error("  1. Missing Chromium/Chrome installation");
      console.error("  2. Insufficient system resources");
      console.error("  3. Incompatible browser flags");
      console.error(
        "  Try: npm install puppeteer --force to reinstall browser",
      );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CRITICAL CLEANUP - Ensure browser is ALWAYS closed and lock is released
    // ═══════════════════════════════════════════════════════════════════════════
    if (browser) {
      try {
        // Close all pages first
        const pages = await browser.pages();
        for (const page of pages) {
          try {
            await page.close();
          } catch (pageCloseError) {
            console.error(
              "[Instagram] Error closing page:",
              pageCloseError.message,
            );
          }
        }
        // Then close browser
        await browser.close();
        console.log("[Instagram] Browser closed successfully after error");
      } catch (closeError) {
        console.error("[Instagram] Error closing browser:", closeError.message);
        // Force kill if normal close fails
        try {
          await browser.process()?.kill("SIGKILL");
          console.log("[Instagram] Browser process force-killed");
        } catch (killError) {
          console.error(
            "[Instagram] Could not force-kill browser:",
            killError.message,
          );
        }
      }
    }

    // Release concurrency lock
    releaseRelationshipLock(relationshipLockKey);
    relationshipLockKey = null;
    console.log("[Instagram] Relationship lock released (error path)");

    // Release account back to pool (failure)
    if (igAccount) {
      const isRateLimit =
        error.message?.toLowerCase().includes("rate limit") ||
        error.message?.toLowerCase().includes("too many requests");
      await accountPool.releaseAccount(
        igAccount._id,
        false,
        isRateLimit ? "rate_limit" : "error",
      );
      console.log(
        `[Instagram] Account @${igAccount.username} released with failure status`,
      );
    }

    return {
      code: 500,
      success: false,
      message: `failed-to-scrape-${type}`,
      error: error.message,
      error_type: error.name || "UnknownError",
    };
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════════════════════════
const collectRelationships = async ({
  targetUsername,
  type = "followers",
  limit,
  cursor = null,
  jobId = null,
  chunkSize = null,
  pauseChecker = null,
  user_id,
  folder_id,
  provider = RELATIONSHIP_PROVIDER_TYPES.GRAPHQL,
}) => {
  const requestType = normalizeRelationshipRequestType(type);
  const relationshipProvider = resolveRelationshipProvider({ provider });

  const response = await scrapeFollowersOrFollowing({
    targetUsername,
    type: requestType,
    maxLimit: limit,
    user_id,
    folder_id,
    withGraphQl: relationshipProvider === RELATIONSHIP_PROVIDER_TYPES.GRAPHQL,
    provider: relationshipProvider,
    __checkPause: pauseChecker,
    job_id: jobId,
    cursor,
    chunkSize,
  });

  return {
    provider: relationshipProvider,
    success: Boolean(response?.success),
    status: response?.success ? "SUCCEEDED" : "FAILED",
    target_username: targetUsername,
    type: requestType,
    relationship_type: toRelationshipDirection(requestType),
    collected_count: response?.data?.count || response?.data?.total_scraped || 0,
    saved_count: response?.data?.inserted_count || response?.data?.leads?.length || 0,
    raw: response,
  };
};

const BetaInstagramService = {
  scrapeInstagram,
  scrapeInstagramBulk,
  deepScanExternalUrl,
  enrichProfile,
  enrichProfiles,
  collectRelationships,
  createApifyRelationshipScrapeJob,
  startQueuedApifyRelationshipJob,
  processApifyRelationshipWebhook,
  scrapeFollowersOrFollowing,
  scrapeFollowersOrFollowingGraphQL, // Export GraphQL method separately
};

BetaInstagramService.__testables = {
  normalizeAndDedupeUsernames,
  chunkUsernames,
  buildApifyEnrichmentPlan,
  resolveRelationshipProvider,
};

export default BetaInstagramService;
