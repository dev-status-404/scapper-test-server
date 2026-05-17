import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAndDedupeUsernames,
  chunkUsernames,
  buildApifyEnrichmentPlan,
} from "../../src/services/instagram/apifyBatchPlanner.js";

test("followers enrichment with 250 usernames creates 3 chunks: 100,100,50", () => {
  const usernames = Array.from({ length: 250 }, (_, i) => `user_${i + 1}`);
  const plan = buildApifyEnrichmentPlan({
    usernames,
    context: { jobType: "followers", jobId: "job-1", userId: "user-1" },
    chunkSize: 100,
    maxChunkSize: 500,
    allowSingleAsFinalLeftover: true,
  });

  assert.equal(plan.chunks.length, 3);
  assert.deepEqual(plan.chunks.map((chunk) => chunk.length), [100, 100, 50]);
});

test("following enrichment with 250 usernames creates 3 chunks: 100,100,50", () => {
  const usernames = Array.from({ length: 250 }, (_, i) => `user_${i + 1}`);
  const plan = buildApifyEnrichmentPlan({
    usernames,
    context: { jobType: "following", jobId: "job-2", userId: "user-1" },
    chunkSize: 100,
    maxChunkSize: 500,
    allowSingleAsFinalLeftover: true,
  });

  assert.equal(plan.chunks.length, 3);
  assert.deepEqual(plan.chunks.map((chunk) => chunk.length), [100, 100, 50]);
});

test("single profile scrape allows one chunk with input_count=1", () => {
  const plan = buildApifyEnrichmentPlan({
    usernames: ["openai"],
    context: { jobType: "single_profile", jobId: "job-3", userId: "user-1" },
    chunkSize: 100,
    maxChunkSize: 500,
  });

  assert.equal(plan.chunks.length, 1);
  assert.equal(plan.chunks[0].length, 1);
});

test("relationship jobs with one username fail unless explicitly marked as final leftover", () => {
  assert.throws(
    () =>
      buildApifyEnrichmentPlan({
        usernames: ["only_one"],
        context: { jobType: "followers", jobId: "job-4", userId: "user-1" },
        chunkSize: 100,
        maxChunkSize: 500,
        allowSingleAsFinalLeftover: false,
      }),
    /Use batch enrichment/,
  );
});

test("final leftover chunk of 1 is allowed after full chunks", () => {
  const usernames = Array.from({ length: 201 }, (_, i) => `user_${i + 1}`);
  const plan = buildApifyEnrichmentPlan({
    usernames,
    context: { jobType: "followers", jobId: "job-5", userId: "user-1" },
    chunkSize: 100,
    maxChunkSize: 500,
    allowSingleAsFinalLeftover: true,
  });

  assert.deepEqual(plan.chunks.map((chunk) => chunk.length), [100, 100, 1]);
});

test("cached usernames are removed before enrichment call", () => {
  const plan = buildApifyEnrichmentPlan({
    usernames: ["alpha", "beta", "gamma", "delta"],
    cachedUsernames: ["beta", "delta"],
    context: { jobType: "followers", jobId: "job-6", userId: "user-1" },
    chunkSize: 100,
    maxChunkSize: 500,
    allowSingleAsFinalLeftover: true,
  });

  assert.deepEqual(plan.uncachedUsernames, ["alpha", "gamma"]);
});

test("duplicate usernames are removed before enrichment call", () => {
  const deduped = normalizeAndDedupeUsernames([
    "@OpenAI",
    "openai",
    "OPENAI",
    "sam_altman",
    "sam_altman",
  ]);

  assert.deepEqual(deduped, ["openai", "sam_altman"]);
  assert.deepEqual(chunkUsernames(deduped, 100).map((chunk) => chunk.length), [2]);
});
