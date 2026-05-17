/**
 * adminBillingRoutes.js
 * All routes require admin authentication.
 * Mounted at /api/admin/billing in app.js
 */

import express from "express";
import auth from "../middlewares/auth.js";
import {
  adminListSubscriptions,
  adminCancelSubscription,
  adminListCharges,
  adminIssueRefund,
  adminListPromoCodes,
  adminCreatePromoCode,
  adminDeactivatePromoCode,
} from "../controllers/adminBillingController.js";

const router = express.Router();

// All admin billing routes require admin role
router.use(auth(["ADMIN"]));

// ── Subscriptions ─────────────────────────────────────────────────────────────
router.get("/subscriptions", adminListSubscriptions);
router.post("/subscriptions/:userId/cancel", adminCancelSubscription);

// ── Refunds ───────────────────────────────────────────────────────────────────
router.get("/charges", adminListCharges);
router.post("/refund", adminIssueRefund);

// ── Promo codes ───────────────────────────────────────────────────────────────
router.get("/promo-codes", adminListPromoCodes);
router.post("/promo-codes", adminCreatePromoCode);
router.patch("/promo-codes/:promoCodeId/deactivate", adminDeactivatePromoCode);

export default router;
