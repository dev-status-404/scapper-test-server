import express from "express";
import cors from "cors";
import { campaignController } from "../controllers/campaignController.js";
import auth from "../middlewares/auth.js";
import {
  requireActiveSubscription,
  requireCampaignSlot,
} from "../middlewares/planGuard.js";

const router = express.Router();

// Open CORS for public tracking endpoints — hit by email clients and image proxies
// that send no Origin header or come from arbitrary origins.
const publicTrackingCors = cors({
  origin: "*",
  methods: ["GET"],
  allowedHeaders: ["ngrok-skip-browser-warning"],
});

// Campaign routes
router.post(
  "/create",
  auth(["USER", "ADMIN"]),
  requireActiveSubscription,
  requireCampaignSlot,
  campaignController.createCampaign
);
router.get("/get", campaignController.getCampaigns);
router.get("/get-by-id", campaignController.getCampaignById);
router.post("/update", campaignController.updateCampaign);
router.delete("/delete", campaignController.deleteCampaign);
router.post("/schedule/:id", auth(["USER", "ADMIN"]), campaignController.scheduleCampaign);
router.post("/send", campaignController.sendCampaign);
router.get("/stats", auth(["USER", "ADMIN"]), campaignController.getCampaignStats);

// Tracking routes — public, no auth, allow any origin
router.get(
  "/track/:campaignId/:leadId/open/:trackingId",
  publicTrackingCors,
  campaignController.trackEmailOpen,
);
router.get(
  "/track/:campaignId/:leadId/click/:trackingId",
  publicTrackingCors,
  campaignController.trackEmailClick,
);

export default router;
