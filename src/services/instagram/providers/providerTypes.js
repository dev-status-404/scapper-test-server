export const PROFILE_PROVIDER_TYPES = {
  APIFY: "apify",
  INSTAGRAM_API: "instagram_api",
  STEADY_API: "steady_api",
};

export const RELATIONSHIP_PROVIDER_TYPES = {
  GRAPHQL: "graphql",
  PUPPETEER: "puppeteer",
  APIFY: "apify",
};

export const RELATIONSHIP_PROVIDER_CAPABILITIES = {
  [RELATIONSHIP_PROVIDER_TYPES.GRAPHQL]: {
    provider: RELATIONSHIP_PROVIDER_TYPES.GRAPHQL,
    supportsFollowers: true,
    supportsFollowing: true,
    supportsCursorResume: true,
    supportsProfileEnrichment: false,
  },
  [RELATIONSHIP_PROVIDER_TYPES.PUPPETEER]: {
    provider: RELATIONSHIP_PROVIDER_TYPES.PUPPETEER,
    supportsFollowers: true,
    supportsFollowing: true,
    supportsCursorResume: false,
    supportsProfileEnrichment: false,
  },
  [RELATIONSHIP_PROVIDER_TYPES.APIFY]: {
    provider: RELATIONSHIP_PROVIDER_TYPES.APIFY,
    supportsFollowers: false,
    supportsFollowing: false,
    supportsCursorResume: false,
    supportsProfileEnrichment: false,
  },
};

export const getRelationshipProviderCapabilities = (provider) =>
  RELATIONSHIP_PROVIDER_CAPABILITIES[provider] || null;

export const APIFY_RUN_STATUSES = {
  CREATED: "CREATED",
  RUNNING: "RUNNING",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  TIMED_OUT: "TIMED_OUT",
  ABORTED: "ABORTED",
  PARTIAL: "PARTIAL",
};

export const SCRAPE_JOB_STATUSES = {
  QUEUED: "QUEUED",
  RUNNING: "RUNNING",
  PAUSED: "PAUSED",
  CANCEL_REQUESTED: "CANCEL_REQUESTED",
  CANCELLED: "CANCELLED",
  SUCCEEDED: "SUCCEEDED",
  PARTIAL: "PARTIAL",
  FAILED: "FAILED",
  TIMED_OUT: "TIMED_OUT",
};

export const SCRAPE_JOB_STAGES = {
  VALIDATING: "VALIDATING",
  COLLECTING_RELATIONSHIPS: "COLLECTING_RELATIONSHIPS",
  SAVING_RAW_USERS: "SAVING_RAW_USERS",
  DEDUPING: "DEDUPING",
  ENRICHING_PROFILES: "ENRICHING_PROFILES",
  DEEP_SCANNING: "DEEP_SCANNING",
  SAVING_LEADS: "SAVING_LEADS",
  RECONCILING_CREDITS: "RECONCILING_CREDITS",
  COMPLETED: "COMPLETED",
};
