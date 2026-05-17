import InstagramRelationshipRaw from "../../models/instagramRelationshipRaw.model.js";
import { normalizeInstagramUsername, normalizeRelationshipUser } from "./normalizers.js";
import { toRelationshipDirection } from "./relationshipTypes.js";

const RAW_RELATIONSHIP_CHUNK_SIZE = 1000;

export const buildRawRelationshipBulkOps = ({
  jobId,
  userId,
  targetUsername,
  relationshipType,
  users,
  sourceProvider,
  cursorPage = null,
  keepRawPayload = false,
}) => {
  const normalizedTarget = normalizeInstagramUsername(targetUsername);
  const relationshipDirection = toRelationshipDirection(relationshipType);

  return (users || [])
    .map((user) => {
      const normalized = normalizeRelationshipUser(user, sourceProvider);
      if (!normalized.username) return null;

      return {
        updateOne: {
          filter: {
            job_id: jobId,
            relationship_type: relationshipDirection,
            username: normalized.username,
          },
          update: {
            $setOnInsert: {
              job_id: jobId,
              user_id: userId,
              target_username: normalizedTarget,
              relationship_type: relationshipDirection,
              username: normalized.username,
              collected_at: new Date(),
            },
            $set: {
              instagram_profile_id: normalized.instagram_profile_id,
              full_name: normalized.full_name,
              is_private: normalized.is_private,
              is_verified: normalized.is_verified,
              avatar_url: normalized.avatar_url,
              cursor_page: cursorPage,
              source_provider: sourceProvider,
              raw_payload: keepRawPayload ? normalized.raw : null,
            },
          },
          upsert: true,
        },
      };
    })
    .filter(Boolean);
};

export const bulkUpsertRawRelationships = async ({
  jobId,
  userId,
  targetUsername,
  relationshipType,
  users,
  sourceProvider,
  cursorPage = null,
  keepRawPayload = false,
  chunkSize = RAW_RELATIONSHIP_CHUNK_SIZE,
}) => {
  const ops = buildRawRelationshipBulkOps({
    jobId,
    userId,
    targetUsername,
    relationshipType,
    users,
    sourceProvider,
    cursorPage,
    keepRawPayload,
  });

  let upsertedCount = 0;
  let modifiedCount = 0;

  for (let index = 0; index < ops.length; index += chunkSize) {
    const chunk = ops.slice(index, index + chunkSize);
    const result = await InstagramRelationshipRaw.bulkWrite(chunk, { ordered: false });
    upsertedCount += result.upsertedCount || 0;
    modifiedCount += result.modifiedCount || 0;
  }

  return {
    requested: users?.length || 0,
    processed: ops.length,
    upsertedCount,
    modifiedCount,
    duplicateCount: Math.max(0, ops.length - upsertedCount),
  };
};

export default {
  buildRawRelationshipBulkOps,
  bulkUpsertRawRelationships,
};
