import express from "express";
import auth from "../middlewares/auth.js";
import {
  getPlans,
  getSubscription,
  createCheckout,
  createPortalSession,
  cancelSubscription,
  changePlan,
  startFreeTrial,
  syncSession,
  stripeWebhook,
} from "../controllers/stripeController.js";

const router = express.Router();

// ── Public ────────────────────────────────────────────────────────────────────

/** List all active plans */
router.get("/plans", getPlans);

/**
 * Stripe webhook – raw body parsing is handled in app.js via
 * app.use('/api/billing/webhook', express.raw(...)) BEFORE express.json().
 */
router.post("/webhook", stripeWebhook);

// ── Authenticated ─────────────────────────────────────────────────────────────

/** Get current user's subscription */
router.get("/subscription", auth(["USER", "ADMIN"]), getSubscription);

/** Create a Stripe Checkout session */
router.post("/checkout", auth(["USER", "ADMIN"]), createCheckout);

/** Create a Stripe Customer Portal session */
router.post("/portal", auth(["USER", "ADMIN"]), createPortalSession);

/** Cancel subscription at period end */
router.post("/cancel", auth(["USER", "ADMIN"]), cancelSubscription);

/** Change plan (upgrade or downgrade) */
router.post("/change-plan", auth(["USER", "ADMIN"]), changePlan);

/** Start 14-day free trial (no Stripe) */
router.post("/free-trial", auth(["USER", "ADMIN"]), startFreeTrial);

/** Sync subscription from a completed checkout session */
router.post("/sync-session", auth(["USER", "ADMIN"]), syncSession);

export default router;
