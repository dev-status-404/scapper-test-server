import createError from "http-errors";
import mongoose from "mongoose";
import Lead from "../models/lead.model.js";
import UserLead from "../models/userLead.model.js";
import userLeadService from "./userLeadService.js";

const toObjectId = (id) =>
  mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id;

// ✅ match userId in all shapes (ObjectId | string | {$oid})
const buildUserMatch = (userId) => {
  const uid = toObjectId(userId);
  const uidStr = String(userId);
  return {
    $or: [{ user_id: uid }, { user_id: uidStr }, { "user_id.$oid": uidStr }],
  };
};

const buildNotDeletedMatch = () => ({
  $or: [{ is_deleted: false }, { is_deleted: { $exists: false } }],
});

const buildUserScopedLeadMatch = (userId, filters = {}) =>
  userLeadService.buildUserScopedLeadMatch(userId, {
    folder_id: filters.folder_id,
    type: filters.type || undefined,
    scraped_from_username: filters.scraped_from_username || undefined,
  });

const applyUserLeadContext = (lead, contextsByLeadId) => {
  const context = contextsByLeadId?.get(String(lead?._id));
  if (!context) return lead;

  return {
    ...lead,
    user_lead_id: context._id,
    user_lead: {
      _id: context._id,
      folder_id: context.folder_id || null,
      type: context.type,
      scraped_from_username: context.scraped_from_username,
      relationship_type: context.relationship_type,
      is_cached: context.is_cached,
      createdAt: context.createdAt,
      updatedAt: context.updatedAt,
    },
    folder_id: context.folder_id || lead.folder_id,
    type: context.type || lead.type,
    scraped_from_username:
      context.scraped_from_username || lead.scraped_from_username,
    relationship_type: context.relationship_type || lead.relationship_type,
    is_cached_lead: Boolean(context.is_cached),
  };
};

const buildUTCDateRange = ({ days, dateFrom, dateTo }) => {
  const now = new Date();

  const from = dateFrom ? new Date(dateFrom) : null;
  const to = dateTo ? new Date(dateTo) : null;

  const validFrom = from && !Number.isNaN(from.getTime()) ? from : null;
  const validTo = to && !Number.isNaN(to.getTime()) ? to : null;

  // explicit date range
  if (validFrom && validTo) {
    const startUTC = new Date(
      Date.UTC(
        validFrom.getUTCFullYear(),
        validFrom.getUTCMonth(),
        validFrom.getUTCDate(),
        0,
        0,
        0,
        0,
      ),
    );
    const endUTC = new Date(
      Date.UTC(
        validTo.getUTCFullYear(),
        validTo.getUTCMonth(),
        validTo.getUTCDate(),
        23,
        59,
        59,
        999,
      ),
    );
    const daysCount = Math.max(
      1,
      Math.ceil((endUTC - startUTC) / 86400000) + 1,
    );
    return { startUTC, endUTC, daysCount };
  }

  // fallback last N days
  const n = Math.min(Math.max(parseInt(days || "7", 10) || 7, 1), 90);
  const startUTC = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - (n - 1),
      0,
      0,
      0,
      0,
    ),
  );

  return { startUTC, endUTC: now, daysCount: n };
};

const createLead = async (payload) => {
  try {
    const lead = await Lead.create(payload);
    if (payload?.user_id) {
      await userLeadService
        .upsertUserLead({
          user_id: payload.user_id,
          lead_id: lead._id,
          folder_id: payload.folder_id || null,
          type: payload.type || lead.type || "MANUAL",
          scraped_from_username: payload.scraped_from_username || null,
          relationship_type: payload.relationship_type || null,
          is_cached: false,
        })
        .catch(() => {});
    }
    return {
      code: 201,
      success: true,
      message: "created-successfully",
      data: lead,
    };
  } catch (error) {
    throw error;
  }
};

const getLead = async (filters = {}) => {
  try {
    const {
      folder_id,
      user_id,
      is_converted,
      page = 1,
      limit = 10,
      search,
      scrape_id,
      _id,
      scrape_status,
      has_contacts,
      type = "",
      scraped_from_username,
    } = filters;

    if (!user_id) throw createError(400, "user-id-required");

    const { scope: userMatch, contextsByLeadId } =
      await buildUserScopedLeadMatch(user_id, {
        folder_id,
        type,
        scraped_from_username,
      });

    const query = {
      $and: [userMatch, buildNotDeletedMatch()],
    };

    // ✅ Search: support emails[] AND old email
    if (search) {
      const searchTerm = String(search).trim();
      const terms = searchTerm.split(/\s+/);

      query.$and.push({
        $or: [
          { first_name: { $regex: searchTerm, $options: "i" } },
          { last_name: { $regex: searchTerm, $options: "i" } },
          { company: { $regex: searchTerm, $options: "i" } },
          { job_title: { $regex: searchTerm, $options: "i" } },
          { message: { $regex: searchTerm, $options: "i" } },

          // ✅ old email
          { email: { $regex: searchTerm, $options: "i" } },

          // ✅ emails array
          { emails: { $elemMatch: { $regex: searchTerm, $options: "i" } } },
          { phone_numbers: { $elemMatch: { $regex: searchTerm, $options: "i" } } },

          // Full name search
          ...(terms.length > 1
            ? [
                {
                  $and: [
                    { first_name: { $regex: terms[0], $options: "i" } },
                    {
                      last_name: {
                        $regex: terms.slice(1).join(" "),
                        $options: "i",
                      },
                    },
                  ],
                },
              ]
            : []),
        ],
      });
    }

    // exact filters
    if (scrape_id && String(scrape_id)) {
      query.$and.push({ scrape_id: scrape_id });
    }

    if (_id && String(_id)) {
      query.$and.push({ _id: _id });
    }

    if (typeof scrape_status !== "undefined" && String(scrape_status) !== "") {
      query.$and.push({
        scrape_status:
          scrape_status === true || String(scrape_status).toLowerCase() === "true",
      });
    }

    if (typeof is_converted !== "undefined") {
      query.$and.push({
        is_converted: is_converted === "true" || is_converted === true,
      });
    }

    if (has_contacts === "true" || has_contacts === true) {
      query.$and.push({
        $or: [
          { emails: { $exists: true, $not: { $size: 0 }, $ne: [] } },
          { phone_numbers: { $exists: true, $not: { $size: 0 }, $ne: [] } },
        ],
      });
    }

    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const [leads, total] = await Promise.all([
      Lead.find(query)
        .populate({
          path: "folder_id",
          select: "name",
          match: { is_deleted: false },
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit, 10))
        .lean(),
      Lead.countDocuments(query),
    ]);

    const enrichedLeads = leads.map((lead) =>
      applyUserLeadContext(lead, contextsByLeadId),
    );

    return {
      code: 200,
      success: true,
      message: "fetched-successfully",
      data: enrichedLeads,
      pagination: {
        total,
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        totalPages: Math.ceil(total / parseInt(limit, 10)),
      },
    };
  } catch (error) {
    throw error;
  }
};

/**
 * ✅ NEW: Summary endpoint for leads page
 * GET /leads/summary?user_id=...&days=7&type=&folder_id=&dateFrom=&dateTo=
 */
const getLeadSummary = async (filters = {}) => {
  try {
    const { user_id, days, dateFrom, dateTo, type = "", folder_id } = filters;
    if (!user_id) throw createError(400, "user-id-required");

    const { startUTC, endUTC, daysCount } = buildUTCDateRange({
      days,
      dateFrom,
      dateTo,
    });

    const userLeadMatch = userLeadService.buildUserLeadMatch(user_id, {
      folder_id,
      type,
      is_deleted: false,
    });

    const deletedUserLeadMatch = userLeadService.buildUserLeadMatch(user_id, {
      folder_id,
      type,
      is_deleted: true,
    });

    const leadLookupPipeline = [
      {
        $lookup: {
          from: "leads",
          localField: "lead_id",
          foreignField: "_id",
          as: "lead",
        },
      },
      { $unwind: "$lead" },
      { $match: { "lead.is_deleted": { $ne: true } } },
    ];

    // ✅ build labels
    const labels = [];
    for (let i = 0; i < daysCount; i++) {
      const d = new Date(startUTC);
      d.setUTCDate(startUTC.getUTCDate() + i);
      labels.push(d.toISOString().slice(0, 10));
    }

    const [statsAgg, deletedAgg, dailyTotalAgg, dailyByTypeAgg] =
      await Promise.all([
        // stats: total + converted + byType (active)
        UserLead.aggregate([
          { $match: userLeadMatch },
          ...leadLookupPipeline,
          {
            $facet: {
              totals: [
                {
                  $group: {
                    _id: null,
                    total: { $sum: 1 },
                    converted: {
                      $sum: {
                        $cond: [{ $eq: ["$lead.is_converted", true] }, 1, 0],
                      },
                    },
                  },
                },
              ],
              byType: [{ $group: { _id: "$type", count: { $sum: 1 } } }],
            },
          },
        ]),

        // deleted count
        UserLead.aggregate([
          { $match: deletedUserLeadMatch },
          { $count: "deleted" },
        ]),

        // daily total (active + date range)
        UserLead.aggregate([
          { $match: userLeadMatch },
          ...leadLookupPipeline,
          {
            $match: {
              createdAt: { $gte: startUTC, $lte: endUTC },
            },
          },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%Y-%m-%d",
                  date: "$createdAt",
                  timezone: "UTC",
                },
              },
              count: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ]),

        // daily by type (active + date range)
        UserLead.aggregate([
          { $match: userLeadMatch },
          ...leadLookupPipeline,
          {
            $match: {
              createdAt: { $gte: startUTC, $lte: endUTC },
            },
          },
          {
            $group: {
              _id: {
                day: {
                  $dateToString: {
                    format: "%Y-%m-%d",
                    date: "$createdAt",
                    timezone: "UTC",
                  },
                },
                type: "$type",
              },
              count: { $sum: 1 },
            },
          },
          { $sort: { "_id.day": 1 } },
        ]),
      ]);

    const totalsRow = statsAgg?.[0]?.totals?.[0] || { total: 0, converted: 0 };
    const byTypeRows = statsAgg?.[0]?.byType || [];
    const deleted = deletedAgg?.[0]?.deleted || 0;

    const byType = { INSTAGRAM: 0, LINKEDIN: 0, MANUAL: 0 };
    for (const r of byTypeRows) {
      if (!r?._id) continue;
      byType[String(r._id).toUpperCase()] = r.count;
    }

    // map daily total
    const dailyTotalMap = {};
    for (const r of dailyTotalAgg || []) dailyTotalMap[r._id] = r.count;
    const dailyTotalCounts = labels.map((l) => dailyTotalMap[l] || 0);

    // map daily by type
    const typeMap = { INSTAGRAM: {}, LINKEDIN: {}, MANUAL: {} };
    for (const r of dailyByTypeAgg || []) {
      const day = r?._id?.day;
      const t = String(r?._id?.type || "").toUpperCase();
      if (!day || !t) continue;
      if (!typeMap[t]) typeMap[t] = {};
      typeMap[t][day] = r.count;
    }

    const countsByType = {
      INSTAGRAM: labels.map((d) => typeMap.INSTAGRAM[d] || 0),
      LINKEDIN: labels.map((d) => typeMap.LINKEDIN[d] || 0),
      MANUAL: labels.map((d) => typeMap.MANUAL[d] || 0),
    };

    return {
      code: 200,
      success: true,
      message: "leads-summary-fetched",
      data: {
        stats: {
          total: totalsRow.total || 0,
          byType,
          converted: totalsRow.converted || 0,
          deleted,
        },
        charts: {
          dailyTotal: { labels, counts: dailyTotalCounts },
          dailyByType: { labels, countsByType },
        },
      },
    };
  } catch (error) {
    throw error;
  }
};

const updateLead = async (payload) => {
  try {
    const leadId = payload._id || payload.lead_id;
    if (!leadId) {
      return { code: 400, success: false, message: "lead_id-is-required" };
    }

    // Remove helper keys before applying the update
    const { lead_id, _id, user_id, folder_id, ...restUpdateData } = payload;
    const existingLead = user_id
      ? await Lead.findById(leadId).select("_id type folder_id user_id").lean()
      : null;

    if (user_id && existingLead && typeof folder_id !== "undefined") {
      await userLeadService.upsertUserLead({
        user_id,
        lead_id: leadId,
        folder_id: folder_id || null,
        type: restUpdateData.type || existingLead.type || "MANUAL",
        scraped_from_username:
          restUpdateData.scraped_from_username || payload.scraped_from_username || null,
        relationship_type:
          restUpdateData.relationship_type || payload.relationship_type || null,
        is_cached: String(existingLead.user_id || "") !== String(user_id),
      });
    }

    const updateData = user_id
      ? restUpdateData
      : { ...restUpdateData, ...(typeof folder_id !== "undefined" ? { folder_id } : {}) };

    if (Object.keys(updateData).length === 0) {
      const lead = await Lead.findOne({ _id: leadId, is_deleted: false });
      if (!lead) {
        return { code: 404, success: false, message: "lead-not-found" };
      }

      return {
        code: 200,
        success: true,
        message: "updated-successfully",
        data: lead,
      };
    }

    const lead = await Lead.findOneAndUpdate(
      { _id: leadId, is_deleted: false },
      { $set: updateData },
      { new: true },
    );

    if (!lead) {
      return { code: 404, success: false, message: "lead-not-found" };
    }

    return {
      code: 200,
      success: true,
      message: "updated-successfully",
      data: lead,
    };
  } catch (error) {
    throw error;
  }
};

const deleteLead = async (filters = {}) => {
  try {
    const { lead_id, user_id } = filters;
    if (!lead_id) {
      return { code: 400, success: false, message: "lead_id-is-required" };
    }

    const lead = await Lead.findOne({ _id: lead_id });

    if (!lead) {
      return { code: 404, success: false, message: "lead-not-found" };
    }

    if (user_id) {
      await userLeadService.deleteUserLead({ user_id, lead_id });
    } else {
      await Lead.updateOne({ _id: lead_id }, { is_deleted: true });
    }

    return {
      code: 200,
      success: true,
      message: "deleted-successfully",
      data: lead,
    };
  } catch (error) {
    throw error;
  }
};

const escapeCsv = (v) => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  // wrap if contains comma/quote/newline
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
};

const leadsToCsv = (leads) => {
  const headers = [
    "id",
    "first_name",
    "last_name",
    "emails",
    "phones",
    "company",
    "job_title",
    "message",
    "type",
    "is_converted",
    "converted_at",
    "folder_id",
    "createdAt",
    "updatedAt",
  ];

  const rows = leads.map((l) => [
    l._id,
    l.first_name || "",
    l.last_name || "",
    Array.isArray(l.emails) ? l.emails.join("; ") : "",
    Array.isArray(l.phone_numbers)
      ? l.phone_numbers.join("; ")
      : Array.isArray(l.phones)
        ? l.phones.join("; ")
        : "",
    l.company || "",
    l.job_title || "",
    l.message || "",
    l.type || "",
    l.is_converted ? "true" : "false",
    l.converted_at || "",
    l.folder_id?._id || l.folder_id || "",
    l.createdAt || "",
    l.updatedAt || "",
  ]);

  return [
    headers.map(escapeCsv).join(","),
    ...rows.map((r) => r.map(escapeCsv).join(",")),
  ].join("\n");
};

// ✅ NEW: download all leads (no pagination) + same filters as getLead
const downloadAllLeads = async (filters = {}) => {
  const {
    user_id,
    folder_id,
    is_converted,
    search,
    type = "",
    scraped_from_username,
  } = filters;

  if (!user_id) throw createError(400, "user-id-required");

  const { scope, contextsByLeadId } = await buildUserScopedLeadMatch(user_id, {
    folder_id,
    type,
    scraped_from_username,
  });

  const query = {
    $and: [scope, buildNotDeletedMatch()],
  };

  // ✅ Search (includes emails + phones arrays)
  if (search) {
    const searchTerm = String(search).trim();
    const terms = searchTerm.split(/\s+/);

    query.$and.push({
      $or: [
        { first_name: { $regex: searchTerm, $options: "i" } },
        { last_name: { $regex: searchTerm, $options: "i" } },
        { company: { $regex: searchTerm, $options: "i" } },
        { job_title: { $regex: searchTerm, $options: "i" } },
        { message: { $regex: searchTerm, $options: "i" } },

        // old single email (if exists in old docs)
        { email: { $regex: searchTerm, $options: "i" } },

        // ✅ arrays
        { emails: { $elemMatch: { $regex: searchTerm, $options: "i" } } },
        { phones: { $elemMatch: { $regex: searchTerm, $options: "i" } } },
        { phone_numbers: { $elemMatch: { $regex: searchTerm, $options: "i" } } },

        ...(terms.length > 1
          ? [
              {
                $and: [
                  { first_name: { $regex: terms[0], $options: "i" } },
                  {
                    last_name: {
                      $regex: terms.slice(1).join(" "),
                      $options: "i",
                    },
                  },
                ],
              },
            ]
          : []),
      ],
    });
  }

  if (typeof is_converted !== "undefined") {
    query.$and.push({
      is_converted: is_converted === "true" || is_converted === true,
    });
  }

  // ✅ Fetch ALL matching leads
  const leads = await Lead.find(query)
    .populate({
      path: "folder_id",
      select: "name",
      match: { is_deleted: false },
    })
    .sort({ createdAt: -1 })
    .lean();

  const csv = leadsToCsv(
    leads.map((lead) => applyUserLeadContext(lead, contextsByLeadId)),
  );

  return {
    code: 200,
    success: true,
    message: "download-ready",
    filename: `leads_${new Date().toISOString().slice(0, 10)}.csv`,
    csv,
    count: leads.length,
  };
};

const bulkDeleteLead = async (filters = {}) => {
  try {
    const { lead_ids, user_id } = filters;
    if (!lead_ids) {
      return { code: 400, success: false, message: "lead_ids-is-required" };
    }

    if (user_id && lead_ids.length > 0) {
      await userLeadService.bulkDeleteUserLeads({ user_id, lead_ids });
    } else {
      await Lead.updateMany(
        { _id: { $in: lead_ids } },
        { is_deleted: true },
      );
    }

    return {
      code: 200,
      success: true,
      message: "deleted-successfully",
      data: { matched: lead_ids.length },
    };
  } catch (error) {
    throw error;
  }
};

const uploadBulkLeads = async ({ folder_id, user_id, leads }) => {
  try {
    if (!folder_id || !mongoose.Types.ObjectId.isValid(folder_id)) {
      return {
        code: 400,
        success: false,
        message: "Valid folder_id is required",
      };
    }

    if (!user_id || !mongoose.Types.ObjectId.isValid(user_id)) {
      return {
        code: 400,
        success: false,
        message: "Valid user_id is required",
      };
    }

    if (!Array.isArray(leads) || leads.length === 0) {
      return {
        code: 400,
        success: false,
        message: "Leads array is required",
      };
    }

    // Clean + normalize
    const preparedLeads = leads.map((lead) => ({
      first_name: lead.first_name || "",
      last_name: lead.last_name || "",
      emails: Array.isArray(lead.emails) ? lead.emails : [],
      phone_numbers: Array.isArray(lead.phone_numbers)
        ? lead.phone_numbers
        : [],
      company: lead.company || "",
      job_title: lead.job_title || "",
      message: lead.message || "",
      folder_id,
      user_id,
      type: lead.type || "MANUAL",
      is_converted: lead.is_converted ?? false,
      scrape_status: lead.scrape_status ?? false,
    }));
    if (!preparedLeads.length) {
      return {
        code: 400,
        success: false,
        message: "No valid leads found",
      };
    }

    const inserted = await Lead.insertMany(preparedLeads, {
      ordered: false, // continue if one fails
    });

    await userLeadService
      .bulkUpsertUserLeads(
        inserted.map((lead) => ({
          lead_id: lead._id,
          folder_id,
          type: lead.type || "MANUAL",
          is_cached: false,
        })),
        user_id,
      )
      .catch(() => {});

    return {
      code: 201,
      success: true,
      message: "Leads imported successfully",
      data: {
        inserted: inserted.length,
        total: leads.length,
      },
    };
  } catch (error) {
    return {
      code: 500,
      success: false,
      message: error.message,
    };
  }
};

const updateBulkScrappedLeads = async (payload = {}) => {
  try {
    const { leads } = payload;

    if (!Array.isArray(leads) || leads.length === 0) {
      return {
        code: 400,
        success: false,
        message: "Leads array is required",
      };
    }

    const updates = [];
    const linkUpdates = [];
    for (const lead of leads) {
      if (!lead._id) {
        return {
          code: 400,
          success: false,
          message: "Each lead must have an _id",
        };
      }

      const { user_id, folder_id, ...leadUpdate } = lead;
      if (user_id && typeof folder_id !== "undefined") {
        linkUpdates.push({
          user_id,
          lead_id: lead._id,
          folder_id,
          type: lead.type || "MANUAL",
          scraped_from_username: lead.scraped_from_username || null,
          relationship_type: lead.relationship_type || null,
        });
      }

      updates.push({
        updateOne: {
          filter: { _id: lead._id },
          update: {
            $set: {
              ...leadUpdate,
              ...(!user_id && typeof folder_id !== "undefined"
                ? { folder_id }
                : {}),
              scrape_status: true,
            },
          },
        },
      });
    }

    const result = await Lead.bulkWrite(updates, { ordered: false });
    await Promise.all(
      linkUpdates.map((link) =>
        userLeadService.upsertUserLead(link).catch(() => null),
      ),
    );

    return {
      code: 200,
      success: true,
      message: "Leads updated successfully",
      data: {
        matched: result.matchedCount,
        modified: result.modifiedCount,
        total: leads.length,
      },
    };
  } catch (error) {
    throw error;
  }
};

export const leadService = {
  createLead,
  getLead,
  getLeadSummary, // ✅ NEW
  updateLead,
  uploadBulkLeads,
  deleteLead,
  bulkDeleteLead,
  downloadAllLeads,
  updateBulkScrappedLeads,
  getUserLeadStats: userLeadService.getUserLeadStats,
};
