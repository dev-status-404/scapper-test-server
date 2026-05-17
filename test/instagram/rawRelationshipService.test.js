import test from "node:test";
import assert from "node:assert/strict";
import { buildRawRelationshipBulkOps } from "../../src/services/instagram/rawRelationshipService.js";

test("buildRawRelationshipBulkOps creates idempotent upsert operations", () => {
  const ops = buildRawRelationshipBulkOps({
    jobId: "job-1",
    userId: "user-1",
    targetUsername: "https://instagram.com/openai/",
    relationshipType: "followers",
    users: [
      {
        id: "123",
        username: "@Sam.Altman",
        full_name: "Sam Altman",
        is_private: false,
        is_verified: true,
      },
    ],
    sourceProvider: "graphql",
    cursorPage: "cursor-1",
  });

  assert.equal(ops.length, 1);
  assert.deepEqual(ops[0].updateOne.filter, {
    job_id: "job-1",
    relationship_type: "follower",
    username: "sam.altman",
  });
  assert.equal(ops[0].updateOne.update.$setOnInsert.relationship_type, "follower");
  assert.equal(ops[0].updateOne.update.$setOnInsert.target_username, "openai");
  assert.equal(ops[0].updateOne.update.$set.source_provider, "graphql");
  assert.equal(ops[0].updateOne.upsert, true);
});

test("buildRawRelationshipBulkOps stores following direction explicitly", () => {
  const ops = buildRawRelationshipBulkOps({
    jobId: "job-1",
    userId: "user-1",
    targetUsername: "openai",
    relationshipType: "following",
    users: [{ username: "gdb" }],
    sourceProvider: "graphql",
  });

  assert.deepEqual(ops[0].updateOne.filter, {
    job_id: "job-1",
    relationship_type: "following",
    username: "gdb",
  });
  assert.equal(ops[0].updateOne.update.$setOnInsert.relationship_type, "following");
});

test("buildRawRelationshipBulkOps does not collide followers and following", () => {
  const followerOps = buildRawRelationshipBulkOps({
    jobId: "job-1",
    userId: "user-1",
    targetUsername: "openai",
    relationshipType: "followers",
    users: [{ username: "same.user" }],
    sourceProvider: "graphql",
  });

  const followingOps = buildRawRelationshipBulkOps({
    jobId: "job-1",
    userId: "user-1",
    targetUsername: "openai",
    relationshipType: "following",
    users: [{ username: "same.user" }],
    sourceProvider: "graphql",
  });

  assert.notDeepEqual(
    followerOps[0].updateOne.filter,
    followingOps[0].updateOne.filter,
  );
  assert.equal(followerOps[0].updateOne.filter.relationship_type, "follower");
  assert.equal(followingOps[0].updateOne.filter.relationship_type, "following");
});
