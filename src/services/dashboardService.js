import createError from "http-errors";
import UserLead from "../models/userLead.model.js";
import folderModel from "../models/folder.model.js";
import User from "../models/user.model.js";
import Feedback from "../models/feedback.model.js";
import Notifications from "../models/notifications.model.js";
import Bug from "../models/bug.model.js";
import Campaign from "../models/campaign.model.js";
import mongoose from "mongoose";
import userLeadService from "./userLeadService.js";

const toObjectId = (id) =>
  mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id;

// ✅ reusable: date range builder (UTC)
const buildUTCDateRange = ({ days, dateFrom, dateTo }) => {
  const now = new Date();

  const from = dateFrom ? new Date(dateFrom) : null;
  const to = dateTo ? new Date(dateTo) : null;

  const validFrom = from && !Number.isNaN(from.getTime()) ? from : null;
  const validTo = to && !Number.isNaN(to.getTime()) ? to : null;

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

// ✅ IMPORTANT: support ObjectId, string, and { $oid: "..." }
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

/* ============ USER DASHBOARD ============ */
const getUserDashboardData = async (userId, filters = {}) => {
  const { startUTC, endUTC, daysCount } = buildUTCDateRange(filters);
  const userLeadMatch = userLeadService.buildUserLeadMatch(userId, {
    is_deleted: false,
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

  // ✅ labels (UTC)
  const labels = [];
  for (let i = 0; i < daysCount; i++) {
    const d = new Date(startUTC);
    d.setUTCDate(startUTC.getUTCDate() + i);
    labels.push(d.toISOString().slice(0, 10));
  }

  const [
    totalLeads,
    convertedLeads,
    byTypeAgg,
    rangeTotal,
    recentLeadsRaw,
    totalFolders,
    recentFolders,
    weeklyAgg,
    weeklyAggByType,
    topFolderAgg,
    totalCampaigns,
    campaignsByStatus,
    recentCampaigns,
    campaignDailyAgg,
  ] = await Promise.all([
    UserLead.aggregate([
      { $match: userLeadMatch },
      ...leadLookupPipeline,
      { $count: "total" },
    ]),

    UserLead.aggregate([
      { $match: userLeadMatch },
      ...leadLookupPipeline,
      { $match: { "lead.is_converted": true } },
      { $count: "converted" },
    ]),

    // ✅ byType totals (all-time)
    UserLead.aggregate([
      { $match: userLeadMatch },
      ...leadLookupPipeline,
      { $group: { _id: "$type", count: { $sum: 1 } } },
    ]),

    // ✅ leads created in selected range
    UserLead.aggregate([
      { $match: { ...userLeadMatch, createdAt: { $gte: startUTC, $lte: endUTC } } },
      ...leadLookupPipeline,
      { $count: "total" },
    ]),

    UserLead.find(userLeadMatch)
      .sort({ createdAt: -1 })
      .limit(8)
      .populate({
        path: "lead_id",
        select:
          "_id first_name last_name email emails phone_numbers company job_title message createdAt folder_id type user_id is_converted",
      })
      .populate({
        path: "folder_id",
        select: "name",
        match: { is_deleted: false },
      })
      .lean(),

    folderModel.countDocuments({ user_id: toObjectId(userId) }),

    folderModel
      .find({ user_id: toObjectId(userId) })
      .sort({ createdAt: -1 })
      .limit(6)
      .select("_id name createdAt")
      .lean(),

    // ✅ combined chart (range)
    UserLead.aggregate([
      { $match: { ...userLeadMatch, createdAt: { $gte: startUTC, $lte: endUTC } } },
      ...leadLookupPipeline,
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

    // ✅ by-type chart (range)
    UserLead.aggregate([
      { $match: { ...userLeadMatch, createdAt: { $gte: startUTC, $lte: endUTC } } },
      ...leadLookupPipeline,
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

    // ✅ top folder by leads (all-time)
    UserLead.aggregate([
      { $match: userLeadMatch },
      ...leadLookupPipeline,
      { $group: { _id: "$folder_id", leads: { $sum: 1 } } },
      { $sort: { leads: -1 } },
      { $limit: 1 },
    ]),

    // ✅ campaigns: total count
    Campaign.countDocuments({
      user_id: toObjectId(userId),
      is_deleted: false,
    }),

    // ✅ campaigns: by status
    Campaign.aggregate([
      { $match: { user_id: toObjectId(userId), is_deleted: false } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),

    // ✅ recent campaigns
    Campaign.find({
      user_id: toObjectId(userId),
      is_deleted: false,
    })
      .sort({ createdAt: -1 })
      .limit(5)
      .select(
        "_id name subject status analytics.sent analytics.opened analytics.clicked total_recipients scheduled_at sent_at createdAt",
      )
      .lean(),

    // ✅ campaigns daily sent (range)
    Campaign.aggregate([
      {
        $match: {
          user_id: toObjectId(userId),
          is_deleted: false,
          sent_at: { $gte: startUTC, $lte: endUTC },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$sent_at",
              timezone: "UTC",
            },
          },
          count: { $sum: 1 },
          totalSent: { $sum: "$analytics.sent" },
          totalOpened: { $sum: "$analytics.opened" },
          totalClicked: { $sum: "$analytics.clicked" },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);

  // ✅ normalize email for frontend (legacy email + new emails[])
  const totalLeadsCount = totalLeads?.[0]?.total || 0;
  const convertedLeadsCount = convertedLeads?.[0]?.converted || 0;
  const rangeTotalCount = rangeTotal?.[0]?.total || 0;

  const recentLeads = (recentLeadsRaw || []).map((link) => {
    const leadDoc = link.lead_id || {};
    const fromOld =
      typeof leadDoc.email === "string" && leadDoc.email ? leadDoc.email : null;
    const fromArr =
      Array.isArray(leadDoc.emails) && leadDoc.emails.length
        ? leadDoc.emails[0]
        : null;
    const primary = fromOld || fromArr;
    const contextMap = new Map([
      [String(leadDoc._id), { ...link, lead_id: leadDoc._id }],
    ]);

    return {
      ...applyUserLeadContext(leadDoc, contextMap),
      primary_email: primary,
      emails: Array.isArray(leadDoc.emails)
        ? leadDoc.emails
        : fromOld
          ? [fromOld]
          : [],
    };
  });

  // ✅ chart: combined counts
  const countMap = {};
  for (const row of weeklyAgg || []) countMap[row._id] = row.count;
  const counts = labels.map((l) => countMap[l] || 0);

  // ✅ chart: by-type counts (NOW includes MANUAL)
  const byTypeMap = { INSTAGRAM: {}, LINKEDIN: {}, MANUAL: {} };
  for (const row of weeklyAggByType || []) {
    const day = row?._id?.day;
    const type = String(row?._id?.type || "").toUpperCase();
    if (!day || !type) continue;
    if (!byTypeMap[type]) byTypeMap[type] = {};
    byTypeMap[type][day] = row.count;
  }

  const countsByType = {
    INSTAGRAM: labels.map((d) => byTypeMap.INSTAGRAM[d] || 0),
    LINKEDIN: labels.map((d) => byTypeMap.LINKEDIN[d] || 0),
    MANUAL: labels.map((d) => byTypeMap.MANUAL[d] || 0),
  };

  // ✅ byType totals map
  const byType = { INSTAGRAM: 0, LINKEDIN: 0, MANUAL: 0 };
  for (const r of byTypeAgg || []) {
    const t = String(r._id || "").toUpperCase();
    if (t in byType) byType[t] = r.count;
  }

  // ✅ campaigns: status distribution
  const campaignsByStatusMap = {
    DRAFT: 0,
    SCHEDULED: 0,
    SENDING: 0,
    SENT: 0,
    PAUSED: 0,
    CANCELLED: 0,
  };
  for (const row of campaignsByStatus || []) {
    if (row._id in campaignsByStatusMap) {
      campaignsByStatusMap[row._id] = row.count;
    }
  }

  // ✅ campaigns: aggregate analytics
  let totalCampaignsSent = 0;
  let totalCampaignsOpened = 0;
  let totalCampaignsClicked = 0;

  for (const campaign of recentCampaigns || []) {
    totalCampaignsSent += campaign.analytics?.sent || 0;
    totalCampaignsOpened += campaign.analytics?.opened || 0;
    totalCampaignsClicked += campaign.analytics?.clicked || 0;
  }

  // ✅ campaigns: chart data (daily)
  const campaignDailyMap = {
    count: {},
    sent: {},
    opened: {},
    clicked: {},
  };

  for (const row of campaignDailyAgg || []) {
    campaignDailyMap.count[row._id] = row.count;
    campaignDailyMap.sent[row._id] = row.totalSent || 0;
    campaignDailyMap.opened[row._id] = row.totalOpened || 0;
    campaignDailyMap.clicked[row._id] = row.totalClicked || 0;
  }

  const campaignDailyCounts = labels.map((l) => campaignDailyMap.count[l] || 0);
  const campaignDailySent = labels.map((l) => campaignDailyMap.sent[l] || 0);
  const campaignDailyOpened = labels.map(
    (l) => campaignDailyMap.opened[l] || 0,
  );
  const campaignDailyClicked = labels.map(
    (l) => campaignDailyMap.clicked[l] || 0,
  );

  const conversionRate =
    totalLeadsCount > 0
      ? Math.round((convertedLeadsCount / totalLeadsCount) * 100)
      : 0;

  const avgPerDay =
    daysCount > 0 ? Number((rangeTotalCount / daysCount).toFixed(2)) : 0;

  // ✅ top folder name (optional)
  let topFolder = null;
  if (topFolderAgg?.[0]?._id) {
    const folder = await folderModel
      .findById(topFolderAgg[0]._id)
      .select("_id name")
      .lean();
    if (folder) topFolder = { ...folder, leads: topFolderAgg[0].leads };
  }

  return {
    mode: "user",
    range: {
      dateFrom: startUTC.toISOString().slice(0, 10),
      dateTo: endUTC.toISOString().slice(0, 10),
      daysCount,
    },
    totals: {
      leads: totalLeadsCount,
      converted: convertedLeadsCount,
      conversionRate, // %
      folders: totalFolders,
      byType,
      campaigns: totalCampaigns,
      campaignsByStatus: campaignsByStatusMap,
    },
    insights: {
      newLeadsInRange: rangeTotalCount,
      avgLeadsPerDay: avgPerDay,
      topFolder,
      campaignMetrics: {
        totalSent: totalCampaignsSent,
        totalOpened: totalCampaignsOpened,
        totalClicked: totalCampaignsClicked,
        openRate:
          totalCampaignsSent > 0
            ? Number(
                ((totalCampaignsOpened / totalCampaignsSent) * 100).toFixed(2),
              )
            : 0,
        clickRate:
          totalCampaignsSent > 0
            ? Number(
                ((totalCampaignsClicked / totalCampaignsSent) * 100).toFixed(2),
              )
            : 0,
      },
    },
    recent: {
      leads: recentLeads,
      folders: recentFolders,
      campaigns: (recentCampaigns || []).map((c) => {
        const sent = c.analytics?.sent || 0;
        const opened = c.analytics?.opened || 0;
        return {
          ...c,
          emails_sent: sent,
          open_rate: sent > 0 ? Number(((opened / sent) * 100).toFixed(2)) : 0,
        };
      }),
    },
    charts: {
      leadsAdded: { labels, counts },
      leadsAddedByType: { labels, countsByType },
      campaignsSent: {
        labels,
        campaignCount: campaignDailyCounts,
        emailsSent: campaignDailySent,
        emailsOpened: campaignDailyOpened,
        emailsClicked: campaignDailyClicked,
      },
    },
  };
};

/* ============ ADMIN DASHBOARD (OPTIMIZED) ============ */
const getAdminDashboardData = async (filters = {}) => {
  const { startUTC, endUTC, daysCount } = buildUTCDateRange(filters);

  // ✅ labels (UTC) for charts
  const labels = [];
  for (let i = 0; i < daysCount; i++) {
    const d = new Date(startUTC);
    d.setUTCDate(startUTC.getUTCDate() + i);
    labels.push(d.toISOString().slice(0, 10));
  }

  // ✅ Adjust this to your real "blocked" field(s)
  // If your schema uses "is_blocked", keep it.
  // If it's "isBlocked" or "status: BLOCKED", change this filter.
  const blockedFilter = { is_blocked: true };

  const recentUserSelect =
    "_id name email role is_admin is_blocked created_at updated_at";
  const recentFeedbackSelect = "_id  feedback createdAt";
  const recentBugSelect = "_id  title bug  createdAt";

  const [
    // totals
    totalUsers,
    totalBlockedUsers,
    totalFeedbacks,
    totalBugs,

    // recent lists
    recentUsers,
    recentFeedbacks,
    recentBugs,

    // chart (range)
    usersDailyAgg,
  ] = await Promise.all([
    User.countDocuments({}),
    User.countDocuments(blockedFilter),
    Feedback.countDocuments({}),
    Bug.countDocuments({}),

    User.find({})
      .sort({ createdAt: -1 })
      .limit(10)
      .select(recentUserSelect)
      .lean(),

    Feedback.find({})
      .sort({ createdAt: -1 })
      .limit(10)
      .select(recentFeedbackSelect)
      .populate({ path: "user_id", select: recentUserSelect })
      .lean(),

    Bug.find({})
      .sort({ createdAt: -1 })
      .limit(10)
      .select(recentBugSelect)
      .populate({ path: "user_id", select: recentUserSelect })
      .lean(),

    // ✅ users created per day in selected range (UTC)
    User.aggregate([
      { $match: { created_at: { $gte: startUTC, $lte: endUTC } } },
      {
        $group: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$created_at",
              timezone: "UTC",
            },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);

  // ✅ chart normalization (fill missing days with 0)
  const countMap = {};
  for (const row of usersDailyAgg || []) countMap[row._id] = row.count;
  const counts = labels.map((l) => countMap[l] || 0);

  // ✅ optional: quick insights derived from chart
  const rangeUsersTotal = counts.reduce((a, b) => a + b, 0);
  const avgUsersPerDay = daysCount
    ? Number((rangeUsersTotal / daysCount).toFixed(2))
    : 0;

  return {
    mode: "admin",
    range: {
      dateFrom: startUTC.toISOString().slice(0, 10),
      dateTo: endUTC.toISOString().slice(0, 10),
      daysCount,
    },
    totals: {
      users: totalUsers,
      blockedUsers: totalBlockedUsers,
      feedbacks: totalFeedbacks,
      bugs: totalBugs,
    },
    insights: {
      newUsersInRange: rangeUsersTotal,
      avgUsersPerDay,
    },
    recent: {
      users: recentUsers,
      feedbacks: recentFeedbacks,
      bugs: recentBugs,
    },
    charts: {
      // ✅ ONLY users chart (as you requested)
      usersCreated: { labels, counts },
    },
  };
};

/* ============ ENTRY POINT ============ */
const getDashboardData = async (data) => {
  const { user_id: userId, days, dateFrom, dateTo, user_id } = data || {};
  if (!userId) throw createError(400, "user-id-required");

  const user = await User.findById(userId).select("_id name email role");
  if (!user) throw createError(404, "user-not-found");

  const role = (user.role || "").toLowerCase();

  const dashboard =
    role === "admin"
      ? await getAdminDashboardData({ days, dateFrom, dateTo, user_id })
      : await getUserDashboardData(userId, { days, dateFrom, dateTo, user_id }); // ✅ pass filters

  return {
    success: true,
    message: `${role}-dashboard-fetched`,
    code: 200,
    data: { ...dashboard },
  };
};
export const dashboardService = {
  getDashboardData,
  getUserDashboardData,
  getAdminDashboardData,
};
