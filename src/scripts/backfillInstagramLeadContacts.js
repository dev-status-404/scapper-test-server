#!/usr/bin/env node

import mongoose from "mongoose";
import dotenv from "dotenv";
import Lead from "../models/lead.model.js";
import {
  applyContactSnapshotToProfile,
  buildDeepScanTargetsForLeads,
} from "../services/instagram/contactEnrichmentService.js";
import { normalizeEmailCandidate } from "../utils/extractor.js";
import {
  DEEP_SCAN_RELATIONSHIP_ENABLED,
  enqueueDeepScanBatch,
} from "../services/deepScanService.js";

dotenv.config();

const parseArgs = (argv = []) => {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;

    const [rawKey, inlineValue] = token.slice(2).split("=");
    const nextToken = argv[index + 1];
    const hasNextValue =
      inlineValue === undefined &&
      typeof nextToken === "string" &&
      !nextToken.startsWith("--");

    parsed[rawKey] = inlineValue ?? (hasNextValue ? nextToken : "true");
    if (hasNextValue) {
      index += 1;
    }
  }

  return parsed;
};

const normalizeList = (values = []) =>
  [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];

const normalizeEmailList = (values = []) =>
  [...new Set(values.map((value) => normalizeEmailCandidate(value)).filter(Boolean))];

const toObjectIdOrNull = (value) =>
  mongoose.Types.ObjectId.isValid(value)
    ? new mongoose.Types.ObjectId(value)
    : null;

const buildQuery = ({ targetUsername, leadId, userId }) => {
  const query = {
    type: "INSTAGRAM",
    is_deleted: { $ne: true },
  };

  if (targetUsername) {
    query.scraped_from_username = String(targetUsername).trim().toLowerCase();
  }

  if (leadId) {
    const objectId = toObjectIdOrNull(leadId);
    if (!objectId) {
      throw new Error(`Invalid lead id: ${leadId}`);
    }
    query._id = objectId;
  }

  if (userId) {
    const objectId = toObjectIdOrNull(userId);
    if (!objectId) {
      throw new Error(`Invalid user id: ${userId}`);
    }
    query.user_id = objectId;
  }

  return query;
};

const buildLeadUpdate = (lead) => {
  const enriched = applyContactSnapshotToProfile(lead);
  const emails = normalizeEmailList([
    ...(lead.emails || []),
    ...(enriched.emails || []),
  ]);
  const phoneNumbers = normalizeList([
    ...(lead.phone_numbers || []),
    ...(enriched.phone_numbers || []),
  ]);
  const externalUrls = normalizeList([
    ...(lead.external_urls || []),
    ...(enriched.external_urls || []),
  ]);

  const deepScanStatus =
    DEEP_SCAN_RELATIONSHIP_ENABLED && externalUrls.length > 0
      ? lead.deep_scan_status || "PENDING"
      : lead.deep_scan_status || null;

  const changed =
    JSON.stringify(emails) !== JSON.stringify(lead.emails || []) ||
    JSON.stringify(phoneNumbers) !== JSON.stringify(lead.phone_numbers || []) ||
    JSON.stringify(externalUrls) !== JSON.stringify(lead.external_urls || []) ||
    (externalUrls[0] || null) !== (lead.external_url || null) ||
    deepScanStatus !== (lead.deep_scan_status || null);

  if (!changed) {
    return null;
  }

  return {
    updateOne: {
      filter: { _id: lead._id },
      update: {
        $set: {
          emails,
          phone_numbers: phoneNumbers,
          external_url: externalUrls[0] || null,
          external_urls: externalUrls,
          deep_scan_status: deepScanStatus,
        },
      },
    },
  };
};

const chunk = (items, size) => {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const targetUsername = args.target ?? args.targetUsername ?? null;
  const leadId = args.leadId ?? null;
  const userId = args.userId ?? null;
  const shouldQueueDeepScan = args.queueDeepScan !== "false";

  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error("MONGODB_URI or MONGO_URI must be configured");
  }

  await mongoose.connect(mongoUri);

  const query = buildQuery({ targetUsername, leadId, userId });
  const leads = await Lead.find(query).lean();

  if (!leads.length) {
    console.log(
      JSON.stringify({
        event: "instagram_lead_contact_backfill",
        status: "no-op",
        matched: 0,
      }),
    );
    await mongoose.disconnect();
    return;
  }

  const operations = leads.map(buildLeadUpdate).filter(Boolean);
  if (operations.length > 0) {
    await Lead.bulkWrite(operations, { ordered: false });
  }

  let deepScanQueued = 0;
  if (DEEP_SCAN_RELATIONSHIP_ENABLED && shouldQueueDeepScan) {
    const refreshedLeads = await Lead.find({
      _id: { $in: leads.map((lead) => lead._id) },
    })
      .select("_id user_id username external_url external_urls links")
      .lean();

    const scanTargets = buildDeepScanTargetsForLeads(refreshedLeads);
    const targetsByLeadId = new Map();
    for (const target of scanTargets) {
      if (!targetsByLeadId.has(target.lead_id)) {
        targetsByLeadId.set(target.lead_id, []);
      }
      targetsByLeadId.get(target.lead_id).push(target);
    }
    const targetsByUser = new Map();

    for (const lead of refreshedLeads) {
      const leadIdKey = String(lead._id);
      const userIdKey = lead.user_id ? String(lead.user_id) : null;
      if (!userIdKey) continue;

      const urls = targetsByLeadId.get(leadIdKey) || [];
      if (!urls.length) continue;

      if (!targetsByUser.has(userIdKey)) {
        targetsByUser.set(userIdKey, []);
      }
      targetsByUser.get(userIdKey).push(...urls);
    }

    for (const [leadUserId, userTargets] of targetsByUser.entries()) {
      for (const batch of chunk(userTargets, 100)) {
        const result = await enqueueDeepScanBatch({
          user_id: leadUserId,
          lead_ids: batch.map((target) => target.lead_id),
          urls: batch.map((target) => target.url),
          job_id: null,
        });
        deepScanQueued += result.queued || 0;
      }
    }
  }

  console.log(
    JSON.stringify({
      event: "instagram_lead_contact_backfill",
      status: "completed",
      matched: leads.length,
      updated: operations.length,
      deep_scan_relationship_enabled: DEEP_SCAN_RELATIONSHIP_ENABLED,
      deep_scan_queued: deepScanQueued,
    }),
  );

  await mongoose.disconnect();
};

main().catch(async (error) => {
  console.error(
    JSON.stringify({
      event: "instagram_lead_contact_backfill",
      status: "failed",
      error_message: error.message,
    }),
  );

  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect().catch(() => {});
  }

  process.exit(1);
});
