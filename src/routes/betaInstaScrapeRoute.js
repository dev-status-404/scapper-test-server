import express from "express";
import { BetaInstaController } from "../controllers/betaInstaController.js";
import {
  scrapeLimiter,
  followerScrapeLimiter,
} from "../middlewares/rateLimiters.js";
import auth from "../middlewares/auth.js";
import {
  requireActiveSubscription,
  requireCredits,
} from "../middlewares/planGuard.js";

const router = express.Router();

const scraperGuard = [
  auth(["USER", "ADMIN"]),
  requireActiveSubscription,
  requireCredits(1),
];
const followerScraperGuard = [
  auth(["USER", "ADMIN"]),
  requireActiveSubscription,
  requireCredits(1, false),
];
const jobGuard = [auth(["USER", "ADMIN"])];

// Beta Instagram scraping routes with rate limiting
router.post("/scrape", 
  // scrapeLimiter,
   ...scraperGuard, BetaInstaController.scrapeProfile);
router.post("/deep-scan", 
  // scrapeLimiter,
  auth(["USER", "ADMIN"]),
  requireActiveSubscription,
  BetaInstaController.deepScan,
);
router.post(
  "/webhooks/apify/instagram",
  BetaInstaController.apifyInstagramWebhook,
);
router.post(
  "/scrape-followers",
  // followerScrapeLimiter,
  ...followerScraperGuard,
  BetaInstaController.scrapeFollowersOrFollowing,
);
router.get(
  "/scrape-followers/jobs",
  ...jobGuard,
  BetaInstaController.listFollowersScrapeJobs,
);
router.get(
  "/scrape-followers/queue-status",
  ...jobGuard,
  BetaInstaController.getFollowersQueueStatus,
);
router.get(
  "/scrape-followers/jobs/:jobId",
  ...jobGuard,
  BetaInstaController.getFollowersScrapeJob,
);
router.post(
  "/scrape-followers/jobs/:jobId/pause",
  ...jobGuard,
  BetaInstaController.pauseFollowersScrape,
);
router.post(
  "/scrape-followers/jobs/:jobId/resume",
  ...jobGuard,
  BetaInstaController.resumeFollowersScrape,
);
router.delete(
  "/scrape-followers/jobs/:jobId",
  ...jobGuard,
  BetaInstaController.deleteFollowersScrape,
);

export default router;
