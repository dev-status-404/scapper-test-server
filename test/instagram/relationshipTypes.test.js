import test from "node:test";
import assert from "node:assert/strict";
import { ProviderUnsupportedOperationError } from "../../src/services/instagram/errors.js";
import { buildRelationshipScrapeJobId } from "../../src/services/instagram/relationshipJobUtils.js";
import {
  assertProviderSupportsRelationshipType,
  buildRelationshipProgressPayload,
  relationshipScrapeTitle,
  toRelationshipDirection,
} from "../../src/services/instagram/relationshipTypes.js";
import apifyRelationshipProvider from "../../src/services/instagram/providers/apifyRelationshipProvider.js";
import {
  getRelationshipProviderCapabilities,
  RELATIONSHIP_PROVIDER_TYPES,
} from "../../src/services/instagram/providers/providerTypes.js";

test("followers job creation includes relationship type in idempotency key", () => {
  const jobId = buildRelationshipScrapeJobId({
    targetUsername: "https://instagram.com/openai/",
    type: "followers",
    user_id: "user-1",
    folder_id: "folder-1",
  });

  assert.equal(jobId, "instagram-relationship__user-1__folder-1__followers__openai");
});

test("following job creation uses a distinct idempotency key", () => {
  const followersJobId = buildRelationshipScrapeJobId({
    targetUsername: "openai",
    type: "followers",
    user_id: "user-1",
    folder_id: "folder-1",
  });
  const followingJobId = buildRelationshipScrapeJobId({
    targetUsername: "openai",
    type: "following",
    user_id: "user-1",
    folder_id: "folder-1",
  });

  assert.equal(followingJobId, "instagram-relationship__user-1__folder-1__following__openai");
  assert.notEqual(followersJobId, followingJobId);
});

test("graphql relationship provider capability supports followers and following", () => {
  const capabilities = getRelationshipProviderCapabilities(
    RELATIONSHIP_PROVIDER_TYPES.GRAPHQL,
  );

  assert.equal(capabilities.supportsFollowers, true);
  assert.equal(capabilities.supportsFollowing, true);
  assert.equal(
    assertProviderSupportsRelationshipType({ capabilities }, "followers"),
    true,
  );
  assert.equal(
    assertProviderSupportsRelationshipType({ capabilities }, "following"),
    true,
  );
});

test("puppeteer relationship provider capability supports followers and following", () => {
  const capabilities = getRelationshipProviderCapabilities(
    RELATIONSHIP_PROVIDER_TYPES.PUPPETEER,
  );

  assert.equal(capabilities.supportsFollowers, true);
  assert.equal(capabilities.supportsFollowing, true);
});

test("relationship lead mapping uses canonical direction and source titles", () => {
  assert.equal(toRelationshipDirection("followers"), "follower");
  assert.equal(toRelationshipDirection("following"), "following");
  assert.equal(relationshipScrapeTitle("followers"), "Instagram Followers Scraped");
  assert.equal(relationshipScrapeTitle("following"), "Instagram Following Scraped");
});

test("websocket relationship payload includes direction and progress fields", () => {
  const payload = buildRelationshipProgressPayload({
    jobId: "job-1",
    stage: "SAVING_LEADS",
    provider: "graphql",
    targetUsername: "openai",
    type: "following",
    collectedCount: 10,
    savedCount: 7,
    duplicateCount: 2,
    failedCount: 1,
    requestedLimit: 25,
  });

  assert.equal(payload.job_id, "job-1");
  assert.equal(payload.relationship_type, "following");
  assert.equal(payload.target_username, "openai");
  assert.equal(payload.collected_count, 10);
  assert.equal(payload.saved_count, 7);
  assert.equal(payload.requested_limit, 25);
  assert.equal(payload.provider, "graphql");
  assert.equal(payload.stage, "SAVING_LEADS");
});

test("unsupported relationship provider fails fast for following", async () => {
  assert.throws(
    () => assertProviderSupportsRelationshipType(apifyRelationshipProvider, "following"),
    ProviderUnsupportedOperationError,
  );

  await assert.rejects(
    () => apifyRelationshipProvider.collectRelationships({ type: "following" }),
    ProviderUnsupportedOperationError,
  );
});
