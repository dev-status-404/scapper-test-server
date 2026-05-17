import express from "express";
const router = express.Router();
import { scrapperController } from "../controllers/scrapperController.js";
import { BetaInstaController } from "../controllers/betaInstaController.js";
import auth from "../middlewares/auth.js";
import {
  requireActiveSubscription,
  requireCredits,
} from "../middlewares/planGuard.js";

const scraperGuard = [
  auth(["USER", "ADMIN"]),
  requireActiveSubscription,
  requireCredits(1),
];

// Scrapper routes – each scrape deducts 1 credit
router.post("/scrap-instagram-v1", ...scraperGuard, scrapperController.scrapeInstagramDetail);
router.post("/scrap-linkedin", ...scraperGuard, scrapperController.scrapeLinkedInProfile);
// Callbacks do not deduct credits (they are async responses)
router.post("/signalhire-callback", scrapperController.signalHireCallback);
router.post(
  "/signalhire-instagram-callback",
  scrapperController.signalHireInstagramCallback,
);
router.post("/scrap-instagram", ...scraperGuard, BetaInstaController.scrapeProfile);

export default router;
