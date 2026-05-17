import test from "node:test";
import assert from "node:assert/strict";
import {
  buildApifyRelationshipInput,
  buildApifyRelationshipRunOptions,
  canStartApifyRelationshipRun,
  createApifyRelationshipScrapeJob,
  processApifyRelationshipWebhook,
} from "../../src/services/instagram/apifyRelationshipRunService.js";

test("Apify relationship input isolates followers and caps maxItems", () => {
  const input = buildApifyRelationshipInput({
    jobId: "job-a",
    targetUsername: "https://instagram.com/openai/",
    type: "followers",
    requestedLimit: 25,
  });

  assert.equal(input.targetUsername, "openai");
  assert.equal(input.type, "followers");
  assert.equal(input.maxItems, 25);
  assert.equal(input.sessionKey, "job-a-openai-followers");
  assert.equal(input.proxySession, "job-a");
});

test("Apify relationship input isolates following separately", () => {
  const input = buildApifyRelationshipInput({
    jobId: "job-a",
    targetUsername: "openai",
    type: "following",
    requestedLimit: 10,
  });

  assert.equal(input.type, "following");
  assert.equal(input.sessionKey, "job-a-openai-following");
});

test("Apify run options set maxItems and cost cap", () => {
  const options = buildApifyRelationshipRunOptions({
    requestedLimit: 123,
    costLimitUsd: 4.5,
  });

  assert.equal(options.maxItems, 123);
  assert.equal(options.maxTotalChargeUsd, 4.5);
  assert.equal(options.timeout, 3600);
});

test("Apify concurrency allows separate followers/following when limits permit", async () => {
  const runModel = {
    countDocuments: async () => 0,
  };

  const result = await canStartApifyRelationshipRun({
    userId: "64b64b64b64b64b64b64b64b",
    targetUsername: "openai",
    runModel,
  });

  assert.equal(result.allowed, true);
});

test("duplicate active job prevention is scoped to user target and type", async () => {
  const existingFollowersJob = { _id: "existing", scrape_type: "followers" };
  const queries = [];
  const jobModel = {
    findOne: async (query) => {
      queries.push(query);
      return query.scrape_type === "followers" ? existingFollowersJob : null;
    },
    create: async (payload) => ({ _id: "new", ...payload }),
  };

  const followerResult = await createApifyRelationshipScrapeJob({
    userId: "64b64b64b64b64b64b64b64b",
    targetUsername: "openai",
    type: "followers",
    jobModel,
  });
  const followingResult = await createApifyRelationshipScrapeJob({
    userId: "64b64b64b64b64b64b64b64b",
    targetUsername: "openai",
    type: "following",
    jobModel,
  });

  assert.equal(followerResult.created, false);
  assert.equal(followingResult.created, true);
  assert.equal(queries[0].scrape_type, "followers");
  assert.equal(queries[1].scrape_type, "following");
});

test("Apify webhook processing is idempotent when run already processed", async () => {
  const processedRun = {
    _id: "run-db-id",
    run_id: "apify-run-1",
    processed_at: new Date(),
  };
  const runModel = {
    findOne: async () => processedRun,
  };

  const result = await processApifyRelationshipWebhook({
    payload: { resource: { id: "apify-run-1" } },
    client: {},
    runModel,
    jobModel: {},
  });

  assert.equal(result.idempotent, true);
  assert.equal(result.run, processedRun);
});
