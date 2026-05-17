import Campaign from "../models/campaign.model.js";
import Lead from "../models/lead.model.js";
import UserLead from "../models/userLead.model.js";
import EmailTracking from "../models/emailTracking.model.js";
import { createNotification } from "./notificationService.js";
import { enqueueCampaignEmails } from "./emailQueueService.js";

const forceTracking = (payload = {}) => ({
  ...payload,
  track_opens: true,
  track_clicks: true,
});

const TRACKING_PIXEL_MARKER = "<!--TRACKING_PIXEL-->";

const ensureTrackingPixelMarker = (content) => {
  if (typeof content !== "string" || !content.trim()) return content;
  if (
    content.includes(TRACKING_PIXEL_MARKER) ||
    content.includes("/api/campaign/track/")
  ) {
    return content;
  }

  if (/<\/body>/i.test(content)) {
    return content.replace(/<\/body>/i, `${TRACKING_PIXEL_MARKER}</body>`);
  }

  return `${content}${TRACKING_PIXEL_MARKER}`;
};

const prepareCampaignPayload = (payload = {}) => {
  const nextPayload = forceTracking(payload);
  if (!Object.prototype.hasOwnProperty.call(nextPayload, "content")) {
    return nextPayload;
  }

  return {
    ...nextPayload,
    content: ensureTrackingPixelMarker(nextPayload.content),
  };
};

const finalizeCampaignIfComplete = async (campaign) => {
  if (!campaign || ["SENT", "CANCELLED"].includes(campaign.status)) {
    return campaign;
  }

  const analytics = campaign.analytics || {};
  const completed =
    Number(analytics.delivered || analytics.sent || 0) +
    Number(analytics.bounced || analytics.failed || 0);
  const expected = Number(campaign.total_recipients || 0);

  if (expected > 0 && completed >= expected) {
    campaign.status = "SENT";
    if (!campaign.sent_at) campaign.sent_at = new Date();
    await campaign.save();
  }

  return campaign;
};

const isAcceptedTrackedOpen = (tracking) => {
  if (!tracking?.opened_at) return false;
  return true;
};

const syncCampaignOpenAnalytics = async (campaign) => {
  if (!campaign?._id) return campaign;

  const trackingRows = await EmailTracking.find({
    campaign_id: campaign._id,
    opened_at: { $ne: null },
  }).select("opened_at delivered_at clicked open_count");

  const acceptedRows = trackingRows.filter(isAcceptedTrackedOpen);
  const opened = acceptedRows.reduce(
    (total, row) => total + Math.max(Number(row.open_count || 0), 1),
    0,
  );
  const uniqueOpens = acceptedRows.length;

  if (
    Number(campaign.analytics?.opened || 0) !== opened ||
    Number(campaign.analytics?.unique_opens || 0) !== uniqueOpens
  ) {
    campaign.analytics.opened = opened;
    campaign.analytics.unique_opens = uniqueOpens;
    await Campaign.updateOne(
      { _id: campaign._id },
      {
        $set: {
          "analytics.opened": opened,
          "analytics.unique_opens": uniqueOpens,
        },
      },
    );
  }

  return campaign;
};

const sendCampaignCompletionNotification = async (
  campaign,
  sentCount,
  failedCount,
) => {
  try {
    await createNotification({
      user_id: campaign.user_id,
      title: "Campaign completed",
      type: "info",
      message: `Campaign '${campaign.name}' completed. Sent: ${sentCount}, Failed: ${failedCount}`,
    });
  } catch (notificationError) {
    console.error(
      "Failed to send campaign completion notification:",
      notificationError,
    );
  }
};

const createCampaign = async (payload) => {
  try {
    payload = prepareCampaignPayload(payload);

    if (payload.campaign_type == "SPECIFIC") {
      payload.total_recipients = payload.target_leads.length;
    }
    if (payload.campaign_type == "FOLDER") {
      payload.total_recipients = await UserLead.countDocuments({
        user_id: payload.user_id,
        folder_id: { $in: payload.target_folders },
        is_deleted: false,
      });
      console.log("Total recipients:", payload.total_recipients);
    }
    const campaign = await Campaign.create(payload);
    return {
      code: 201,
      success: true,
      message: "campaign-created-successfully",
      data: campaign,
    };
  } catch (error) {
    throw error;
  }
};

const getAllCampaigns = async (userId, filters = {}) => {
  try {
    const {
      page = 1,
      limit = 10,
      status,
      search,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = filters;

    if (!userId) {
      return {
        code: 400,
        success: false,
        message: "user-id-required",
      };
    }

    const query = {
      user_id: userId,
      is_deleted: false,
    };

    if (status) {
      query.status = status;
    }

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: "i" } },
        { subject: { $regex: search, $options: "i" } },
      ];
    }

    const sortOptions = {};
    sortOptions[sortBy] = sortOrder === "desc" ? -1 : 1;

    const campaigns = await Campaign.find(query)
      .sort(sortOptions)
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .populate("target_leads", "first_name last_name emails")
      .populate("target_folders", "name");

    await Promise.all(
      campaigns.map(async (campaign) => {
        await syncCampaignOpenAnalytics(campaign);
        await finalizeCampaignIfComplete(campaign);
      }),
    );

    const total = await Campaign.countDocuments(query);

    return {
      code: 200,
      success: true,
      message: "campaigns-retrieved-successfully",
      data: campaigns,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    };
  } catch (error) {
    throw error;
  }
};

const getCampaignById = async (campaignId, userId) => {
  try {
    if (!campaignId || !userId) {
      return {
        code: 400,
        success: false,
        message: "campaign-id-required-&-user-id-required",
      };
    }
    const campaign = await Campaign.findOne({
      _id: campaignId,
      user_id: userId,
      is_deleted: false,
    })
      .populate("target_leads", "first_name last_name emails company")
      .populate("target_folders", "name")
      .populate("template_id", "name subject content")
      .populate("smtp_account_id", "label email_address sender_name");

    if (!campaign) {
      return {
        code: 404,
        success: false,
        message: "Campaign not found",
        data: null,
      };
    }

    await syncCampaignOpenAnalytics(campaign);
    await finalizeCampaignIfComplete(campaign);

    return {
      code: 200,
      success: true,
      message: "Campaign retrieved successfully",
      data: campaign,
    };
  } catch (error) {
    throw error;
  }
};

const updateCampaign = async (campaignId, userId, payload) => {
  try {
    payload = prepareCampaignPayload(payload);

    if (!campaignId || !userId) {
      return {
        code: 400,
        success: false,
        message: "campaign-id-required-&-user-id-required",
      };
    }
    const campaign = await Campaign.findOneAndUpdate(
      {
        _id: campaignId,
        user_id: userId,
        is_deleted: false,
        // status: { $in: ['DRAFT', 'SCHEDULED'] }
      },
      payload,
      { new: true, runValidators: true },
    );

    if (!campaign) {
      return {
        code: 404,
        success: false,
        message: "campaign-not-found-or-cannot-be-updated",
        data: null,
      };
    }

    return {
      code: 200,
      success: true,
      message: "campaign-updated-successfully",
      data: campaign,
    };
  } catch (error) {
    throw error;
  }
};

const deleteCampaign = async (campaignId, userId) => {
  try {
    if (!campaignId || !userId) {
      return {
        code: 400,
        success: false,
        message: "campaign-id-required-&-user-id-required",
      };
    }
    const campaign = await Campaign.findOneAndUpdate(
      {
        _id: campaignId,
        user_id: userId,
        is_deleted: false,
      },
      { is_deleted: true },
      { new: true },
    );

    if (!campaign) {
      return {
        code: 404,
        success: false,
        message: "campaign-not-found",
        data: null,
      };
    }

    return {
      code: 200,
      success: true,
      message: "Campaign deleted successfully",
      data: campaign,
    };
  } catch (error) {
    throw error;
  }
};

const scheduleCampaign = async (campaignId, userId, scheduledAt) => {
  try {
    if (!campaignId || !userId) {
      return {
        code: 400,
        success: false,
        message: "campaign-id-required-&-user-id-required",
      };
    }

    if (!scheduledAt) {
      return {
        code: 400,
        success: false,
        message: "scheduled-at-required",
      };
    }
    const campaign = await Campaign.findOneAndUpdate(
      {
        _id: campaignId,
        user_id: userId,
        is_deleted: false,
        status: "DRAFT",
      },
      {
        status: "SCHEDULED",
        scheduled_at: new Date(scheduledAt),
      },
      { new: true, runValidators: true },
    );

    if (!campaign) {
      return {
        code: 404,
        success: false,
        message: "campaign-not-found-or-cannot-be-scheduled",
        data: null,
      };
    }

    return {
      code: 200,
      success: true,
      message: "Campaign scheduled successfully",
      data: campaign,
    };
  } catch (error) {
    throw error;
  }
};

const sendCampaign = async (campaignId, userId) => {
  try {
    const campaign = await Campaign.findOne({
      _id: campaignId,
      user_id: userId,
      is_deleted: false,
      // status: { $in: ['DRAFT', 'SCHEDULED'] }
    });

    if (!campaign) {
      return {
        code: 404,
        success: false,
        message: "not-found",
        data: null,
      };
    }

    // if (!campaign.senderIsVerified) {
    //   return {
    //     code: 400,
    //     success: false,
    //     message: "not-verified",
    //     data: null,
    //   };
    // }

    // Update campaign status to sending
    campaign.status = "SENDING";
    campaign.sent_at = new Date();
    campaign.track_opens = true;
    campaign.track_clicks = true;
    await campaign.save();

    // If campaign has a future scheduled_at, treat as scheduled (status overridden below)
    const isFutureScheduled =
      campaign.scheduled_at && new Date(campaign.scheduled_at) > new Date();

    // Get target leads based on campaign type
    let targetLeads;
    if (campaign.campaign_type === "SPECIFIC") {
      targetLeads = await Lead.find({
        _id: { $in: campaign.target_leads },
        is_deleted: false,
      });
    } else if (campaign.campaign_type === "FOLDER") {
      const userLeadDocs = await UserLead.find(
        {
          user_id: campaign.user_id,
          folder_id: { $in: campaign.target_folders },
          is_deleted: false,
        },
        { lead_id: 1 }
      ).lean();
      const leadIds = userLeadDocs.map((u) => u.lead_id);
      targetLeads = await Lead.find({
        _id: { $in: leadIds },
        is_deleted: false,
      });
    } else {
      return { code: 400, success: false, message: "Invalid campaign type", data: null };
    }

    const validLeads = targetLeads.filter(
      (lead) => lead.emails && lead.emails.length > 0,
    );
    campaign.total_recipients = targetLeads.length;
    await campaign.save();

    if (validLeads.length === 0) {
      campaign.status = "SENT";
      campaign.analytics.sent = 0;
      campaign.analytics.failed = campaign.total_recipients;
      campaign.analytics.bounced = campaign.total_recipients;
      await campaign.save();

      await sendCampaignCompletionNotification(
        campaign,
        campaign.analytics.sent,
        campaign.analytics.failed,
      );

      return {
        code: 200,
        success: true,
        message: "Campaign completed - no valid email addresses found",
        data: campaign,
      };
    }

    // Enqueue all emails via BullMQ (non-blocking)
    // Pass scheduled_at so jobs are delayed until that time in Redis
    const enqueued = await enqueueCampaignEmails(
      campaign,
      validLeads,
      campaign.scheduled_at || null,
    );

    // Correct status: stay SCHEDULED until the worker flips it to SENDING
    if (isFutureScheduled) {
      campaign.status = "SCHEDULED";
      campaign.sent_at = undefined;
      await campaign.save();
    }

    await createNotification({
      user_id: campaign.user_id,
      title: isFutureScheduled ? "Campaign scheduled" : "Campaign queued",
      type: "info",
      message: isFutureScheduled
        ? `Campaign '${campaign.name}' scheduled for ${new Date(campaign.scheduled_at).toUTCString()}. ${enqueued} emails queued.`
        : `Campaign '${campaign.name}' queued ${enqueued} emails for delivery.`,
    }).catch(() => {});

    return {
      code: 200,
      success: true,
      message: isFutureScheduled ? "Campaign scheduled for delivery" : "Campaign queued for delivery",
      data: campaign,
    };
  } catch (error) {
    throw error;
  }
};

const isAutomatedOpenUserAgent = (userAgent = "") => {
  const value = userAgent.toLowerCase();
  if (!value) return false;

  return [
    "crawler",
    "spider",
    "scanner",
    "proofpoint",
    "mimecast",
    "barracuda",
    "safelinks",
    "urlprotect",
    "linkexpander",
    "facebookexternalhit",
    "slackbot",
    "discordbot",
    "curl/",
    "wget/",
    "python-requests",
    "yahoo pipes",
    "outlook-link-rewrite",
    "microsoftpreview",
  ].some((token) => value.includes(token));
};

const shouldIgnoreOpen = (tracking, metadata = {}) => {
  return isAutomatedOpenUserAgent(metadata.userAgent);
};

const trackEmailOpen = async (
  campaignId,
  leadId,
  trackingId,
  metadata = {},
) => {
  try {
    const now = new Date();
    let tracking = await EmailTracking.findOneAndUpdate(
      { tracking_id: trackingId },
      {
        $setOnInsert: {
          campaign_id: campaignId,
          lead_id: leadId,
          tracking_id: trackingId,
          delivered_at: now,
        },
      },
      { upsert: true, new: true },
    );

    if (shouldIgnoreOpen(tracking, metadata)) {
      await EmailTracking.updateOne(
        { _id: tracking._id },
        {
          $inc: { ignored_open_count: 1 },
          $set: {
            last_open_user_agent: metadata.userAgent || null,
            last_open_ip: metadata.ip || null,
          },
        },
      );

      return {
        code: 200,
        success: true,
        message: "Email open ignored",
        data: { isFirstOpen: false, ignored: true },
      };
    }

    let isFirstOpen = false;

    // Use tracking._id and tracking_id only — avoids campaign_id/lead_id mismatch
    const firstOpenResult = await EmailTracking.updateOne(
      { _id: tracking._id, opened_at: null },
      {
        $set: {
          opened_at: now,
          last_opened_at: now,
          last_open_user_agent: metadata.userAgent || null,
          last_open_ip: metadata.ip || null,
        },
        $inc: { open_count: 1 },
      },
      { upsert: false },
    );

    isFirstOpen = Boolean(firstOpenResult.modifiedCount);

    if (!isFirstOpen) {
      await EmailTracking.updateOne(
        { _id: tracking._id },
        {
          $set: {
            last_opened_at: now,
            last_open_user_agent: metadata.userAgent || null,
            last_open_ip: metadata.ip || null,
          },
          $inc: { open_count: 1 },
        },
      );
    }

    // Use campaign_id from the tracking record (authoritative), not URL param
    const resolvedCampaignId = tracking.campaign_id || campaignId;
    await Campaign.findByIdAndUpdate(resolvedCampaignId, {
      $inc: isFirstOpen
        ? {
            "analytics.opened": 1,
            "analytics.unique_opens": 1,
          }
        : { "analytics.opened": 1 },
    });

    return {
      code: 200,
      success: true,
      message: "Email open tracked successfully",
      data: { isFirstOpen },
    };
  } catch (error) {
    throw error;
  }
};

const updateCampaignAnalytics = async (campaignId, eventType, count = 1) => {
  try {
    const updateField = `analytics.${eventType}`;

    const campaign = await Campaign.findByIdAndUpdate(
      campaignId,
      { $inc: { [updateField]: count } },
      { new: true },
    );

    if (!campaign) {
      return {
        code: 404,
        success: false,
        message: "Campaign not found",
        data: null,
      };
    }

    return {
      code: 200,
      success: true,
      message: "Analytics updated successfully",
      data: campaign,
    };
  } catch (error) {
    throw error;
  }
};

const trackEmailClick = async (campaignId, leadId, trackingId) => {
  try {
    const existingTracking = await EmailTracking.findOne({
      campaign_id: campaignId,
      lead_id: leadId,
      tracking_id: trackingId,
    });

    const isFirstClick = !existingTracking || !existingTracking.clicked;
    const campaignUpdate = {
      $inc: { "analytics.clicked": 1 },
    };

    if (!existingTracking) {
      await EmailTracking.create({
        campaign_id: campaignId,
        lead_id: leadId,
        tracking_id: trackingId,
        delivered_at: new Date(),
        opened_at: new Date(),
        clicked: true,
        clicked_at: new Date(),
      });
      campaignUpdate.$inc["analytics.opened"] = 1;
      campaignUpdate.$inc["analytics.unique_opens"] = 1;
      campaignUpdate.$inc["analytics.unique_clicks"] = 1;
    } else if (!existingTracking.clicked) {
      if (!existingTracking.opened_at) {
        existingTracking.opened_at = new Date();
        existingTracking.last_opened_at = existingTracking.opened_at;
        existingTracking.open_count = (existingTracking.open_count || 0) + 1;
        campaignUpdate.$inc["analytics.opened"] = 1;
        campaignUpdate.$inc["analytics.unique_opens"] = 1;
      }
      if (!existingTracking.delivered_at) {
        existingTracking.delivered_at = new Date();
      }
      existingTracking.clicked = true;
      existingTracking.clicked_at = new Date();
      await existingTracking.save();
      campaignUpdate.$inc["analytics.unique_clicks"] = 1;
    } else if (!existingTracking.opened_at) {
      existingTracking.opened_at = new Date();
      existingTracking.last_opened_at = existingTracking.opened_at;
      existingTracking.open_count = (existingTracking.open_count || 0) + 1;
      if (!existingTracking.delivered_at) {
        existingTracking.delivered_at = new Date();
      }
      await existingTracking.save();
      campaignUpdate.$inc["analytics.opened"] = 1;
      campaignUpdate.$inc["analytics.unique_opens"] = 1;
    }

    await Campaign.findByIdAndUpdate(campaignId, campaignUpdate);

    return {
      code: 200,
      success: true,
      message: "Email click tracked successfully",
      data: { isFirstClick },
    };
  } catch (error) {
    throw error;
  }
};

const getCampaignStats = async (userId) => {
  try {
    const campaigns = await Campaign.find({
      user_id: userId,
      is_deleted: false,
    });

    const stats = campaigns.reduce(
      (acc, campaign) => {
        acc.total_campaigns++;
        acc.total_recipients += campaign.total_recipients;
        acc.total_sent += campaign.analytics.sent;
        acc.total_failed += campaign.analytics.failed;
        return acc;
      },
      {
        total_campaigns: 0,
        total_recipients: 0,
        total_sent: 0,
        total_failed: 0,
      },
    );

    return {
      code: 200,
      success: true,
      message: "Campaign stats retrieved successfully",
      data: stats,
    };
  } catch (error) {
    throw error;
  }
};

export const campaignService = {
  createCampaign,
  getAllCampaigns,
  getCampaignById,
  updateCampaign,
  deleteCampaign,
  scheduleCampaign,
  sendCampaign,
  getCampaignStats,
  updateCampaignAnalytics,
  trackEmailOpen,
  trackEmailClick,
};
