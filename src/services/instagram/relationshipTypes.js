import {
  ProviderInvalidInputError,
  ProviderUnsupportedOperationError,
} from "./errors.js";

export const RELATIONSHIP_REQUEST_TYPES = {
  FOLLOWERS: "followers",
  FOLLOWING: "following",
};

export const RELATIONSHIP_DIRECTIONS = {
  FOLLOWER: "follower",
  FOLLOWING: "following",
};

export const normalizeRelationshipRequestType = (type = RELATIONSHIP_REQUEST_TYPES.FOLLOWERS) => {
  const normalized = String(type || "").trim().toLowerCase();
  if (
    normalized !== RELATIONSHIP_REQUEST_TYPES.FOLLOWERS &&
    normalized !== RELATIONSHIP_REQUEST_TYPES.FOLLOWING
  ) {
    throw new ProviderInvalidInputError("invalid-instagram-relationship-type", {
      metadata: { type },
    });
  }

  return normalized;
};

export const toRelationshipDirection = (type) =>
  normalizeRelationshipRequestType(type) === RELATIONSHIP_REQUEST_TYPES.FOLLOWERS
    ? RELATIONSHIP_DIRECTIONS.FOLLOWER
    : RELATIONSHIP_DIRECTIONS.FOLLOWING;

export const relationshipScrapeTitle = (type) =>
  normalizeRelationshipRequestType(type) === RELATIONSHIP_REQUEST_TYPES.FOLLOWERS
    ? "Instagram Followers Scraped"
    : "Instagram Following Scraped";

export const assertProviderSupportsRelationshipType = (provider, type) => {
  const requestType = normalizeRelationshipRequestType(type);
  const capabilities = provider?.capabilities || {};

  if (
    (requestType === RELATIONSHIP_REQUEST_TYPES.FOLLOWERS && !capabilities.supportsFollowers) ||
    (requestType === RELATIONSHIP_REQUEST_TYPES.FOLLOWING && !capabilities.supportsFollowing)
  ) {
    throw new ProviderUnsupportedOperationError("provider-unsupported-relationship-type", {
      provider: capabilities.provider || provider?.provider || "unknown",
      metadata: {
        type: requestType,
        capabilities,
      },
    });
  }

  return true;
};

export const buildRelationshipProgressPayload = ({
  jobId = null,
  stage,
  status = "RUNNING",
  provider,
  targetUsername,
  type,
  collectedCount = 0,
  savedCount = 0,
  duplicateCount = 0,
  failedCount = 0,
  requestedLimit = null,
  costSpentEstimateUsd = null,
  partial = false,
  message = null,
  extra = {},
}) => ({
  job_id: jobId,
  stage,
  status,
  provider,
  target_username: targetUsername,
  relationship_type: toRelationshipDirection(type),
  type: normalizeRelationshipRequestType(type),
  collected_count: collectedCount,
  saved_count: savedCount,
  duplicate_count: duplicateCount,
  failed_count: failedCount,
  requested_limit: requestedLimit,
  cost_spent_estimate_usd: costSpentEstimateUsd,
  partial,
  message,
  ...extra,
  ts: Date.now(),
});

