import express from "express";
import { InstaController } from "../controllers/instaController.js";
import auth from "../middlewares/auth.js";
import {
  requireActiveSubscription,
  requireCredits,
} from "../middlewares/planGuard.js";
const router = express.Router();
// Lead routes
router.post(
  "/scrape",
  auth(["USER", "ADMIN"]),
  requireActiveSubscription,
  requireCredits(1),
  InstaController.scrapeProfile
);

export default router;
