import { campaignService } from "../services/campaignService.js";

const createCampaign = async (req, res) => {
  try {
    const response = await campaignService.createCampaign(req.body);
    return res.status(response.code).json({
      code: response.code,
      success: response.success,
      message: response.message,
      data: response.data,
    });
  } catch (error) {
    return res.status(error.code || 500).json({
      code: error.code || 500,
      success: false,
      message: error.message || "something-went-wrong",
    });
  }
};

const getCampaigns = async (req, res) => {
  try {
    const response = await campaignService.getAllCampaigns(
      req.query.user_id,
      req.query,
    );
    return res.status(response.code).json({
      code: response.code,
      success: response.success,
      message: response.message,
      data: response.data,
      pagination: response.pagination,
    });
  } catch (error) {
    return res.status(error.code || 500).json({
      code: error.code || 500,
      success: false,
      message: error.message || "something-went-wrong",
    });
  }
};

const getCampaignById = async (req, res) => {
  try {
    const response = await campaignService.getCampaignById(
      req.query.campaign_id,
      req.query.user_id,
    );
    return res.status(response.code).json({
      code: response.code,
      success: response.success,
      message: response.message,
      data: response.data,
    });
  } catch (error) {
    return res.status(error.code || 500).json({
      code: error.code || 500,
      success: false,
      message: error.message || "something-went-wrong",
    });
  }
};

const updateCampaign = async (req, res) => {
  try {
    const response = await campaignService.updateCampaign(
      req.body.campaign_id,
      req.body.user_id,
      req.body,
    );
    return res.status(response.code).json({
      code: response.code,
      success: response.success,
      message: response.message,
      data: response.data,
    });
  } catch (error) {
    return res.status(error.code || 500).json({
      code: error.code || 500,
      success: false,
      message: error.message || "something-went-wrong",
    });
  }
};

const deleteCampaign = async (req, res) => {
  try {
    const response = await campaignService.deleteCampaign(
      req.body.campaign_id,
      req.body.user_id,
    );
    return res.status(response.code).json({
      code: response.code,
      success: response.success,
      message: response.message,
      data: response.data,
    });
  } catch (error) {
    return res.status(error.code || 500).json({
      code: error.code || 500,
      success: false,
      message: error.message || "something-went-wrong",
    });
  }
};

const scheduleCampaign = async (req, res) => {
  try {
    const response = await campaignService.scheduleCampaign(
      req.params.id,
      req.user?._id || req.body.user_id,
      req.body.scheduled_at,
    );
    return res.status(response.code).json({
      code: response.code,
      success: response.success,
      message: response.message,
      data: response.data,
    });
  } catch (error) {
    return res.status(error.code || 500).json({
      code: error.code || 500,
      success: false,
      message: error.message || "something-went-wrong",
    });
  }
};

const sendCampaign = async (req, res) => {
  try {
    const response = await campaignService.sendCampaign(
      req.body.campaign_id,
      req.body.user_id,
    );
    return res.status(response.code).json({
      code: response.code,
      success: response.success,
      message: response.message,
      data: response.data,
    });
  } catch (error) {
    return res.status(error.code || 500).json({
      code: error.code || 500,
      success: false,
      message: error.message || "something-went-wrong",
    });
  }
};

const getCampaignStats = async (req, res) => {
  try {
    const userId = req.user?._id?.toString() || req.query.user_id;
    const response = await campaignService.getCampaignStats(userId);
    return res.status(response.code).json({
      code: response.code,
      success: response.success,
      message: response.message,
      data: response.data,
    });
  } catch (error) {
    return res.status(error.code || 500).json({
      code: error.code || 500,
      success: false,
      message: error.message || "something-went-wrong",
    });
  }
};

const TRACKING_PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

const sendTrackingPixel = (res) => {
  res.setHeader("Content-Type", "image/gif");
  res.setHeader("Content-Length", TRACKING_PIXEL.length);
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Allow image proxies (Gmail, Yahoo, etc.) to access this endpoint
  res.setHeader("Access-Control-Allow-Origin", "*");
  // Tell ngrok to bypass the browser interstitial for this response
  res.setHeader("ngrok-skip-browser-warning", "1");
  res.status(200).send(TRACKING_PIXEL);
};

const trackEmailOpen = async (req, res) => {
  const { campaignId, leadId, trackingId } = req.params;
  const userAgent = req.get("user-agent") || "";
  const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req.ip || "";

  console.log(`[TrackOpen] HIT campaignId=${campaignId} leadId=${leadId} trackingId=${trackingId} UA="${userAgent}" IP=${ip}`);

  try {
    const result = await campaignService.trackEmailOpen(campaignId, leadId, trackingId, { userAgent, ip });
    console.log(`[TrackOpen] RESULT:`, JSON.stringify(result?.data));
  } catch (error) {
    console.error("[TrackOpen] ERROR:", error.message, error.stack);
  }

  sendTrackingPixel(res);
};

const trackEmailClick = async (req, res) => {
  try {
    const { campaignId, leadId, trackingId } = req.params;
    const { url } = req.query;

    await campaignService.trackEmailClick(campaignId, leadId, trackingId);

    // Redirect to original URL
    if (url) {
      return res.redirect(String(url));
    } else {
      return res.redirect(process.env.BASE_URL || "/");
    }
  } catch (error) {
    return res.status(500).json({
      code: 500,
      success: false,
      message: error.message || "something-went-wrong",
    });
  }
};

export const campaignController = {
  createCampaign,
  getCampaigns,
  getCampaignById,
  updateCampaign,
  deleteCampaign,
  scheduleCampaign,
  sendCampaign,
  getCampaignStats,
  trackEmailOpen,
  trackEmailClick,
};
