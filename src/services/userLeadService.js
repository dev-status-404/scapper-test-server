/**
 * userLeadService.js
 *
 * Core service for the UserLead junction table.
 *
 * Responsibilities:
 *  1. upsertUserLead         – link a user to an existing lead (idempotent)
 *  2. bulkUpsertUserLeads    – high-throughput bulk link (followers/following)
 *  3. resolveOrCreateLead    – dedup-aware lead creation for single profile scrapes
 *  4. bulkResolveOrCreate    – dedup-aware bulk lead creation for followers/following
 *  5. getUserLeadIds         – get all lead ObjectIds for a user (used by leadService)
 *  6. deleteUserLead         – soft-delete a user→lead link
 *  7. bulkDeleteUserLeads    – soft-delete multiple user→lead links
 */

import mongoose from "mongoose";
import UserLead from "../models/userLead.model.js";
import Lead from "../models/lead.model.js";

const toObjectId = (id) =>
  mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null;

const hasMeaningfulValue = (value) => {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  return true;
};

const normalizeEmailList = (emails = []) =>
  [...new Set((emails || []).map((email) => String(email || "").trim().toLowerCase()).filter(Boolean))];

const normalizePhoneList = (phones = []) =>
  [...new Set((phones || []).map((phone) => String(phone || "").trim()).filter(Boolean))];

const buildCachedLeadMergeUpdate = (payload = {}) => {
  const setFields = {};
  const setCandidates = [
    "first_name",
    "last_name",
    "company",
    "message",
    "source_url",
    "source_rul",
    "instagram_profile_id",
    "username",
    "full_name",
    "bio",
    "avatar_url",
    "avatar_rul",
    "followers",
    "following",
    "follower_count",
    "following_count",
    "total_posts",
    "category",
    "external_url",
    "external_url_linkshimmed",
    "external_urls",
    "is_private",
    "is_verified",
    "is_public",
    "fb_profile_biolink",
    "highlight_reel_count",
    "links",
    "scraped_from_username",
    "relationship_type",
    "scrape_status",
    "type",
  ];

  for (const field of setCandidates) {
    if (hasMeaningfulValue(payload[field])) {
      setFields[field] = payload[field];
    }
  }

  const update = {};
  if (Object.keys(setFields).length > 0) {
    update.$set = setFields;
  }

  const emails = normalizeEmailList(payload.emails || []);
  const phoneNumbers = normalizePhoneList(payload.phone_numbers || []);

  if (emails.length > 0 || phoneNumbers.length > 0) {
    update.$addToSet = {
      ...(emails.length > 0 ? { emails: { $each: emails } } : {}),
      ...(phoneNumbers.length > 0
        ? { phone_numbers: { $each: phoneNumbers } }
        : {}),
    };
  }

  return Object.keys(update).length > 0 ? update : null;
};

// ─── 1. Upsert a single UserLead ─────────────────────────────────────────────
/**
 * Creates a UserLead record linking user → lead.
 * If one already exists (same user_id + lead_id), it is returned as-is.
 *
 * @param {Object} params
 * @param {string} params.user_id
 * @param {string} params.lead_id
 * @param {string} [params.folder_id]
 * @param {string} [params.type]        INSTAGRAM | LINKEDIN | MANUAL
 * @param {string} [params.scraped_from_username]
 * @param {string} [params.relationship_type]  follower | following | null
 * @param {boolean} [params.is_cached]
 * @returns {Promise<{userLead, created: boolean}>}
 */
export const upsertUserLead = async ({
  user_id,
  lead_id,
  folder_id = null,
  type = "MANUAL",
  scraped_from_username = null,
  relationship_type = null,
  is_cached = false,
}) => {
  const uid = toObjectId(user_id);
  const lid = toObjectId(lead_id);

  if (!uid || !lid) {
    throw new Error("upsertUserLead: invalid user_id or lead_id");
  }

  const filter = { user_id: uid, lead_id: lid };

  const update = {
    $set: {
      folder_id: folder_id ? toObjectId(folder_id) : null,
      type: String(type).toUpperCase(),
      scraped_from_username: scraped_from_username || null,
      relationship_type: relationship_type || null,
      is_deleted: false,
    },
    $setOnInsert: {
      user_id: uid,
      lead_id: lid,
      is_cached: Boolean(is_cached),
    },
  };

  const result = await UserLead.findOneAndUpdate(filter, update, {
    upsert: true,
    new: true,
    setDefaultsOnInsert: true,
  });

  const created = result.createdAt?.getTime() === result.updatedAt?.getTime();
  return { userLead: result, created };
};

// ─── 2. Bulk upsert UserLeads ─────────────────────────────────────────────────
/**
 * Efficiently links multiple leads to a user using ordered bulk operations.
 * Uses unordered bulkWrite so one duplicate doesn't abort the entire batch.
 *
 * @param {Array<{lead_id, folder_id?, type?, scraped_from_username?, relationship_type?, is_cached?}>} items
 * @param {string} user_id
 * @returns {Promise<{insertedCount, skippedCount}>}
 */
export const bulkUpsertUserLeads = async (items, user_id) => {
  if (!items || items.length === 0) return { insertedCount: 0, skippedCount: 0 };

  const uid = toObjectId(user_id);
  if (!uid) throw new Error("bulkUpsertUserLeads: invalid user_id");

  const ops = items
    .map((item) => {
      const lid = toObjectId(item.lead_id);
      if (!lid) return null;

      return {
        updateOne: {
          filter: { user_id: uid, lead_id: lid },
          update: {
            $set: {
              folder_id: item.folder_id ? toObjectId(item.folder_id) : null,
              type: String(item.type || "INSTAGRAM").toUpperCase(),
              scraped_from_username: item.scraped_from_username || null,
              relationship_type: item.relationship_type || null,
              is_deleted: false,
            },
            $setOnInsert: {
              user_id: uid,
              lead_id: lid,
              is_cached: Boolean(item.is_cached),
            },
          },
          upsert: true,
        },
      };
    })
    .filter(Boolean);

  if (ops.length === 0) return { insertedCount: 0, skippedCount: items.length };

  // Process in chunks of 500 to avoid oversized batch ops
  const CHUNK_SIZE = 500;
  let totalInserted = 0;

  for (let i = 0; i < ops.length; i += CHUNK_SIZE) {
    const chunk = ops.slice(i, i + CHUNK_SIZE);
    try {
      const result = await UserLead.bulkWrite(chunk, { ordered: false });
      totalInserted += result.upsertedCount || 0;
    } catch (err) {
      // E11000 duplicate key errors are expected (concurrent upserts) — count partial inserts
      if (err.result) {
        totalInserted += err.result.nUpserted || 0;
      }
    }
  }

  return {
    insertedCount: totalInserted,
    skippedCount: items.length - totalInserted,
  };
};

// ─── 3. Resolve or create a single Lead, then link via UserLead ───────────────
/**
 * For single-profile scrapes (Instagram profile / LinkedIn profile):
 *
 * 1. Check if a Lead with the same identifier already exists globally.
 *    – Instagram: match on `username` OR `instagram_profile_id`
 *    – LinkedIn:  match on `source_url`
 * 2. If found → reuse the existing Lead document, mark is_cached=true on UserLead.
 * 3. If not found → create new Lead, then create UserLead.
 *
 * Returns { lead, userLead, fromCache: boolean }
 *
 * @param {Object} leadPayload   – Full lead document payload (minus user_id/folder_id)
 * @param {Object} linkContext   – { user_id, folder_id, type, scraped_from_username, relationship_type }
 */
export const resolveOrCreateLead = async (leadPayload, linkContext) => {
  const {
    user_id,
    folder_id = null,
    type = "INSTAGRAM",
    scraped_from_username = null,
    relationship_type = null,
  } = linkContext;

  // Build the dedup query based on type
  let dedupQuery = null;

  if (type === "INSTAGRAM") {
    const orConditions = [];

    if (leadPayload.username) {
      orConditions.push({ username: leadPayload.username });
    }
    if (leadPayload.instagram_profile_id) {
      orConditions.push({
        instagram_profile_id: leadPayload.instagram_profile_id,
      });
    }
    if (orConditions.length > 0) {
      dedupQuery = { $or: orConditions, type: "INSTAGRAM" };
    }
  } else if (type === "LINKEDIN") {
    if (leadPayload.source_url) {
      dedupQuery = { source_url: leadPayload.source_url, type: "LINKEDIN" };
    }
  }

  let lead = null;
  let fromCache = false;

  if (dedupQuery) {
    lead = await Lead.findOne(dedupQuery).lean();
    if (lead) {
      fromCache = true;
    }
  }

  if (!lead) {
    // Create a fresh lead — include user_id + folder_id for backward compatibility
    lead = await Lead.create({
      ...leadPayload,
      user_id: toObjectId(user_id) || null,
      folder_id: toObjectId(folder_id) || null,
    });
  }

  // Link user → lead via UserLead (idempotent)
  const { userLead } = await upsertUserLead({
    user_id,
    lead_id: lead._id,
    folder_id,
    type,
    scraped_from_username,
    relationship_type,
    is_cached: fromCache,
  });

  return { lead, userLead, fromCache };
};

// ─── 4. Bulk resolve or create Leads + link via UserLead ─────────────────────
/**
 * For bulk follower/following scrapes — processes `leadPayloads` array and:
 *
 * 1. Extracts unique usernames from the batch.
 * 2. Fetches all existing Lead docs for those usernames in ONE query.
 * 3. Determines which are new (need insert) and which are cached (need link only).
 * 4. Bulk inserts new leads with `insertMany`.
 * 5. Bulk upserts UserLead entries for BOTH new and cached leads.
 *
 * Memory optimised: no N+1 queries, one collection scan per batch.
 *
 * @param {Array<Object>} leadPayloads   – Array of lead document payloads
 * @param {Object}        linkContext    – { user_id, folder_id, type, scraped_from_username, relationship_type }
 * @returns {Promise<{insertedLeads, userLeads, cachedCount, newCount}>}
 */
export const bulkResolveOrCreate = async (leadPayloads, linkContext) => {
  if (!leadPayloads || leadPayloads.length === 0) {
    return {
      insertedLeads: [],
      userLeads: { insertedCount: 0, skippedCount: 0 },
      cachedCount: 0,
      newCount: 0,
    };
  }

  const {
    user_id,
    folder_id = null,
    type = "INSTAGRAM",
    scraped_from_username = null,
    relationship_type = null,
  } = linkContext;

  // ── Step 1: gather identifiers for dedup query ────────────────────────────
  const usernames = leadPayloads
    .map((p) => p.username)
    .filter(Boolean)
    .map((u) => u.toLowerCase());

  const profileIds = leadPayloads
    .map((p) => p.instagram_profile_id)
    .filter(Boolean);

  const sourceUrls = leadPayloads.map((p) => p.source_url).filter(Boolean);

  // ── Step 2: ONE DB round-trip to find all existing leads ─────────────────
  let existingLeads = [];

  if (type === "INSTAGRAM" && (usernames.length > 0 || profileIds.length > 0)) {
    const orConditions = [];
    if (usernames.length > 0) {
      orConditions.push({ username: { $in: usernames } });
    }
    if (profileIds.length > 0) {
      orConditions.push({ instagram_profile_id: { $in: profileIds } });
    }

    existingLeads = await Lead.find(
      { $or: orConditions, type: "INSTAGRAM" },
      { _id: 1, username: 1, instagram_profile_id: 1 },
    ).lean();
  } else if (type === "LINKEDIN" && sourceUrls.length > 0) {
    existingLeads = await Lead.find(
      { source_url: { $in: sourceUrls }, type: "LINKEDIN" },
      { _id: 1, source_url: 1 },
    ).lean();
  }

  // ── Step 3: build lookup maps ─────────────────────────────────────────────
  const existingByUsername = new Map();
  const existingById = new Map();
  const existingByUrl = new Map();

  for (const el of existingLeads) {
    if (el.username) existingByUsername.set(el.username.toLowerCase(), el);
    if (el.instagram_profile_id) existingById.set(el.instagram_profile_id, el);
    if (el.source_url) existingByUrl.set(el.source_url, el);
  }

  // ── Step 4: classify payloads as "new" vs "cached" ───────────────────────
  const toInsert = [];
  const cachedLeads = [];

  for (const payload of leadPayloads) {
    let existing = null;

    if (type === "INSTAGRAM") {
      existing =
        (payload.username && existingByUsername.get(payload.username.toLowerCase())) ||
        (payload.instagram_profile_id && existingById.get(payload.instagram_profile_id)) ||
        null;
    } else if (type === "LINKEDIN") {
      existing = (payload.source_url && existingByUrl.get(payload.source_url)) || null;
    }

    if (existing) {
      cachedLeads.push({ _id: existing._id, ...payload });
    } else {
      toInsert.push({
        ...payload,
        user_id: toObjectId(user_id) || null,
        folder_id: toObjectId(folder_id) || null,
      });
    }
  }

  // ── Step 5: bulk insert new leads ─────────────────────────────────────────
  let insertedLeads = [];
  if (toInsert.length > 0) {
    try {
      insertedLeads = await Lead.insertMany(toInsert, { ordered: false });
    } catch (err) {
      if (err.insertedDocs && err.insertedDocs.length > 0) {
        insertedLeads = err.insertedDocs;
      }
      // Log but don't throw — partial inserts are acceptable
      console.error("[UserLeadService] bulkResolveOrCreate insertMany partial error:", err.message);
    }
  }

  // ── Step 6: bulk upsert UserLeads for ALL (new + cached) ─────────────────
  if (cachedLeads.length > 0) {
    const mergeOps = cachedLeads
      .map((lead) => {
        const update = buildCachedLeadMergeUpdate(lead);
        if (!update) return null;

        return {
          updateOne: {
            filter: { _id: lead._id },
            update,
          },
        };
      })
      .filter(Boolean);

    if (mergeOps.length > 0) {
      try {
        await Lead.bulkWrite(mergeOps, { ordered: false });
      } catch (err) {
        console.error(
          "[UserLeadService] bulkResolveOrCreate cached lead merge error:",
          err.message,
        );
      }
    }
  }

  const allLeadIds = [
    ...insertedLeads.map((l) => ({
      lead_id: l._id,
      is_cached: false,
    })),
    ...cachedLeads.map((l) => ({
      lead_id: l._id,
      is_cached: true,
    })),
  ].map((item) => ({
    ...item,
    folder_id,
    type,
    scraped_from_username,
    relationship_type,
  }));

  const userLeadResult = await bulkUpsertUserLeads(allLeadIds, user_id);

  return {
    insertedLeads,
    cachedLeads,
    userLeads: userLeadResult,
    cachedCount: cachedLeads.length,
    newCount: insertedLeads.length,
  };
};

// ─── 5. Get all Lead ObjectIds for a user (for leadService queries) ───────────
/**
 * Returns an array of Lead ObjectIds that a user has linked via UserLeads.
 * Used to extend/replace the legacy user_id filter in getLead queries.
 *
 * @param {string} user_id
 * @param {Object} [filters] – optional { folder_id, type, scraped_from_username, is_deleted }
 * @returns {Promise<mongoose.Types.ObjectId[]>}
 */
export const getUserLeadIds = async (user_id, filters = {}) => {
  const uid = toObjectId(user_id);
  if (!uid) return [];

  const query = {
    user_id: uid,
    is_deleted: filters.is_deleted ?? false,
  };

  if (filters.folder_id && mongoose.Types.ObjectId.isValid(filters.folder_id)) {
    query.folder_id = toObjectId(filters.folder_id);
  }
  if (filters.type) {
    query.type = String(filters.type).toUpperCase();
  }
  if (filters.scraped_from_username) {
    query.scraped_from_username = filters.scraped_from_username;
  }

  const docs = await UserLead.find(query, { lead_id: 1 }).lean();
  return docs.map((d) => d.lead_id);
};

export const getUserLeadContexts = async (user_id, filters = {}) => {
  const uid = toObjectId(user_id);
  if (!uid) return [];

  const query = {
    user_id: uid,
    is_deleted: filters.is_deleted ?? false,
  };

  if (filters.folder_id && mongoose.Types.ObjectId.isValid(filters.folder_id)) {
    query.folder_id = toObjectId(filters.folder_id);
  }
  if (filters.type) {
    query.type = String(filters.type).toUpperCase();
  }
  if (filters.scraped_from_username) {
    query.scraped_from_username = filters.scraped_from_username;
  }

  return UserLead.find(query)
    .populate({
      path: "folder_id",
      select: "name",
      match: { is_deleted: false },
    })
    .lean();
};

export const buildUserScopedLeadMatch = async (user_id, filters = {}) => {
  const contexts = await getUserLeadContexts(user_id, filters);
  const leadIds = contexts.map((context) => context.lead_id).filter(Boolean);
  const contextsByLeadId = new Map(
    contexts.map((context) => [String(context.lead_id), context]),
  );

  const scope = { _id: { $in: leadIds } };

  return { scope, contextsByLeadId, leadIds };
};

export const buildUserLeadMatch = (user_id, filters = {}) => {
  const uid = toObjectId(user_id);
  const match = {
    user_id: uid,
    is_deleted: filters.is_deleted ?? false,
  };

  if (filters.folder_id && mongoose.Types.ObjectId.isValid(filters.folder_id)) {
    match.folder_id = toObjectId(filters.folder_id);
  }
  if (filters.type) {
    match.type = String(filters.type).toUpperCase();
  }
  if (filters.scraped_from_username) {
    match.scraped_from_username = filters.scraped_from_username;
  }

  return match;
};

// ─── 6. Soft-delete a single UserLead ────────────────────────────────────────
export const deleteUserLead = async ({ user_id, lead_id }) => {
  const uid = toObjectId(user_id);
  const lid = toObjectId(lead_id);
  if (!uid || !lid) throw new Error("deleteUserLead: invalid ids");

  await UserLead.updateOne(
    { user_id: uid, lead_id: lid },
    { $set: { is_deleted: true } },
  );
};

// ─── 7. Bulk soft-delete UserLeads ───────────────────────────────────────────
export const bulkDeleteUserLeads = async ({ user_id, lead_ids }) => {
  const uid = toObjectId(user_id);
  if (!uid) throw new Error("bulkDeleteUserLeads: invalid user_id");

  const lids = (lead_ids || []).map(toObjectId).filter(Boolean);
  if (lids.length === 0) return;

  await UserLead.updateMany(
    { user_id: uid, lead_id: { $in: lids } },
    { $set: { is_deleted: true } },
  );
};

// ─── 8. Get cached followers/following leads for a user+target ───────────────
/**
 * Returns existing leads that a user already has for a specific
 * scraped_from_username + relationship_type, sourced exclusively from UserLead.
 *
 * Used to drive smart re-scrape logic:
 *   - count >= maxLimit → full cache hit, skip scraping
 *   - 0 < count < maxLimit → partial hit, scrape (maxLimit - count) more
 *   - count === 0 → fresh scrape
 *
 * @param {string} user_id
 * @param {string} targetUsername  – the profile that was scraped
 * @param {string} relationshipType – "follower" | "following"
 * @returns {Promise<{ count: number, leads: object[] }>}
 */
export const getExistingFollowersForTarget = async (
  user_id,
  targetUsername,
  relationshipType,
) => {
  const uid = toObjectId(user_id);
  if (!uid || !targetUsername) return { count: 0, leads: [] };

  // One query: get all UserLead rows for this user+target+relationship
  const userLeadDocs = await UserLead.find(
    {
      user_id: uid,
      scraped_from_username: targetUsername,
      relationship_type: relationshipType,
      is_deleted: false,
    },
    { lead_id: 1 },
  ).lean();

  if (userLeadDocs.length === 0) return { count: 0, leads: [] };

  const leadIds = userLeadDocs.map((u) => u.lead_id);

  // Fetch the actual lead documents
  const leads = await Lead.find(
    { _id: { $in: leadIds }, is_deleted: false },
  ).lean();

  return { count: leads.length, leads };
};

// ─── 9. Get UserLead stats for a user (lightweight) ──────────────────────────
export const getUserLeadStats = async (user_id) => {
  const uid = toObjectId(user_id);
  if (!uid) return null;

  const stats = await UserLead.aggregate([
    { $match: { user_id: uid, is_deleted: false } },
    {
      $group: {
        _id: "$type",
        count: { $sum: 1 },
        cached: { $sum: { $cond: ["$is_cached", 1, 0] } },
      },
    },
  ]);

  return stats;
};

export default {
  upsertUserLead,
  bulkUpsertUserLeads,
  resolveOrCreateLead,
  bulkResolveOrCreate,
  getUserLeadIds,
  getUserLeadContexts,
  buildUserScopedLeadMatch,
  buildUserLeadMatch,
  deleteUserLead,
  bulkDeleteUserLeads,
  getUserLeadStats,
  getExistingFollowersForTarget,
};
