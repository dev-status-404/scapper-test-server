const parseInteger = (value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const parseFloatValue = (value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const parseBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
};

const parsePorts = (value) =>
  String(value || "")
    .split(",")
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);

export const DEFAULT_APIFY_INSTAGRAM_PROFILE_ACTOR_ID = "dSCLg0C3YEZ83HzYX";

export const instagramConfig = {
  apify: {
    token: process.env.APIFY_API_KEY || "",
    actorId:
      process.env.APIFY_INSTAGRAM_PROFILE_ACTOR_ID ||
      DEFAULT_APIFY_INSTAGRAM_PROFILE_ACTOR_ID,
    followersActorId: process.env.APIFY_INSTAGRAM_FOLLOWERS_ACTOR_ID || "",
    followingActorId: process.env.APIFY_INSTAGRAM_FOLLOWING_ACTOR_ID || "",
    maxProfileChunkSize: parseInteger(process.env.APIFY_MAX_PROFILE_CHUNK_SIZE, 100, {
      min: 1,
      max: 500,
    }),
    maxProfileChunkSizeLarge: parseInteger(
      process.env.APIFY_MAX_PROFILE_CHUNK_SIZE_LARGE,
      500,
      { min: 1, max: 1000 },
    ),
    syncMaxInputCount: parseInteger(process.env.APIFY_SYNC_MAX_INPUT_COUNT, 100, {
      min: 1,
      max: 1000,
    }),
    datasetPageSize: parseInteger(process.env.APIFY_DATASET_PAGE_SIZE, 100, {
      min: 1,
      max: 1000,
    }),
    callWaitSecs: parseInteger(process.env.APIFY_CALL_WAIT_SECS, 120, {
      min: 5,
      max: 300,
    }),
    externalCallTimeoutMs: parseInteger(
      process.env.APIFY_EXTERNAL_CALL_TIMEOUT_MS,
      180000,
      { min: 1000, max: 15 * 60 * 1000 },
    ),
    maxRetries: parseInteger(process.env.APIFY_MAX_RETRIES, 3, {
      min: 0,
      max: 8,
    }),
    retryBaseDelayMs: parseInteger(process.env.APIFY_RETRY_BASE_DELAY_MS, 1000, {
      min: 100,
      max: 60000,
    }),
    retryMaxDelayMs: parseInteger(process.env.APIFY_RETRY_MAX_DELAY_MS, 30000, {
      min: 100,
      max: 5 * 60 * 1000,
    }),
    circuitBreakerFailureThreshold: parseInteger(
      process.env.APIFY_CIRCUIT_BREAKER_FAILURE_THRESHOLD,
      5,
      { min: 1, max: 100 },
    ),
    circuitBreakerCooldownMs: parseInteger(
      process.env.APIFY_CIRCUIT_BREAKER_COOLDOWN_MS,
      60000,
      { min: 1000, max: 60 * 60 * 1000 },
    ),
    maxCostUsdPerJob: parseFloatValue(process.env.APIFY_MAX_COST_USD_PER_JOB, 10, {
      min: 0,
      max: 10000,
    }),
    estimatedProfileCostUsd: parseFloatValue(
      process.env.APIFY_ESTIMATED_PROFILE_COST_USD,
      0.002,
      { min: 0 },
    ),
    maxConcurrentRunsPerUser: parseInteger(
      process.env.APIFY_MAX_CONCURRENT_RUNS_PER_USER,
      1,
      { min: 1, max: 100 },
    ),
    maxConcurrentRunsGlobal: parseInteger(
      process.env.APIFY_MAX_CONCURRENT_RUNS_GLOBAL,
      10,
      { min: 1, max: 100 },
    ),
    maxConcurrentRunsPerTarget: parseInteger(
      process.env.APIFY_MAX_CONCURRENT_RUNS_PER_TARGET,
      2,
      { min: 1, max: 100 },
    ),
    maxConcurrentProfileEnrichmentRuns: parseInteger(
      process.env.APIFY_MAX_CONCURRENT_PROFILE_ENRICHMENT_RUNS,
      5,
      { min: 1, max: 100 },
    ),
    webhookUrl: process.env.APIFY_WEBHOOK_URL || "",
    webhookSecret: process.env.APIFY_WEBHOOK_SECRET || "",
  },
  proxy: {
    host: process.env.PROXY_HOST || "",
    username: process.env.PROXY_USERNAME || "",
    password: process.env.PROXY_PASSWORD || "",
    ports: parsePorts(process.env.PROXY_PORTS),
  },
  deepScan: {
    enabled: parseBoolean(process.env.INSTAGRAM_DEEP_SCAN_ENABLED, false),
    maxUrlsPerJob: parseInteger(process.env.INSTAGRAM_DEEP_SCAN_MAX_URLS_PER_JOB, 50, {
      min: 0,
      max: 10000,
    }),
    concurrency: parseInteger(process.env.INSTAGRAM_DEEP_SCAN_CONCURRENCY, 5, {
      min: 1,
      max: 50,
    }),
    timeoutMs: parseInteger(process.env.INSTAGRAM_DEEP_SCAN_TIMEOUT_MS, 15000, {
      min: 1000,
      max: 120000,
    }),
    maxContentLength: parseInteger(
      process.env.INSTAGRAM_DEEP_SCAN_MAX_CONTENT_LENGTH,
      512 * 1024,
      { min: 1024, max: 10 * 1024 * 1024 },
    ),
    cacheTtlMs: parseInteger(
      process.env.INSTAGRAM_DEEP_SCAN_CACHE_TTL_MS,
      24 * 60 * 60 * 1000,
      { min: 0, max: 30 * 24 * 60 * 60 * 1000 },
    ),
  },
  limits: {
    enrichmentDefaultLimit: parseInteger(
      process.env.INSTAGRAM_ENRICHMENT_DEFAULT_LIMIT,
      100,
      { min: 0, max: 1000000 },
    ),
    enrichmentMaxLimit: parseInteger(process.env.INSTAGRAM_ENRICHMENT_MAX_LIMIT, 3000, {
      min: 1,
      max: 1000000,
    }),
    relationshipMaxLimitFreePlan: parseInteger(
      process.env.INSTAGRAM_RELATIONSHIP_MAX_LIMIT_FREE_PLAN,
      100,
      { min: 1 },
    ),
    relationshipMaxLimitPaidPlan: parseInteger(
      process.env.INSTAGRAM_RELATIONSHIP_MAX_LIMIT_PAID_PLAN,
      3000,
      { min: 1 },
    ),
    relationshipMaxLimitEnterprise: parseInteger(
      process.env.INSTAGRAM_RELATIONSHIP_MAX_LIMIT_ENTERPRISE,
      1000000,
      { min: 1 },
    ),
  },
};

export const hasProxyConfig = () =>
  Boolean(
    instagramConfig.proxy.host &&
      instagramConfig.proxy.username &&
      instagramConfig.proxy.password &&
      instagramConfig.proxy.ports.length > 0,
  );

export const requireProxyConfig = () => {
  if (!hasProxyConfig()) {
    throw new Error(
      "Proxy configuration is incomplete. Set PROXY_HOST, PROXY_USERNAME, PROXY_PASSWORD, and PROXY_PORTS.",
    );
  }

  return instagramConfig.proxy;
};

export const requireApifyConfig = () => {
  if (!instagramConfig.apify.token) {
    throw new Error("APIFY_API_KEY is required for Apify profile enrichment.");
  }

  return instagramConfig.apify;
};
