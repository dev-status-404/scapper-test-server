import { stripeService } from "../services/stripeService.js";
import Plan from "../models/plan.model.js";
import Subscription from "../models/subscription.model.js";
import { t } from "i18next";

const safeError = (err, res) => {
  const code = err.statusCode || err.code || 500;
  return res
    .status(code)
    .json({ code, success: false, message: t(err.message || "Something went wrong") });
};

// ─── Plans ────────────────────────────────────────────────────────────────────

/**
 * GET /api/billing/plans
 * Public – returns all active plans (no sensitive Stripe IDs exposed).
 */
export const getPlans = async (req, res) => {
  try {
    const plans = await Plan.find({ is_active: true }).select(
      "name display_name price_cents price_cents_annual interval credits_per_cycle max_smtp_domains max_campaigns trial_days features features_extra has_annual_price"
    );
    // Annotate each plan with whether an annual price is available
    const data = plans.map((p) => ({
      ...p.toObject(),
      has_annual_price: Boolean(p.stripe_price_id_annual),
    }));
    return res.status(200).json({ code: 200, success: true, data });
  } catch (err) {
    return safeError(err, res);
  }
};

// ─── Subscription status ──────────────────────────────────────────────────────

/**
 * GET /api/billing/subscription
 * Authenticated – returns the current user's subscription details.
 */
export const getSubscription = async (req, res) => {
  try {
    const subscription = await stripeService.getActiveSubscription(req.user._id);
    if (!subscription) {
      return res.status(404).json({
        code: 404,
        success: false,
        message: "No active subscription found",
      });
    }
    return res.status(200).json({ code: 200, success: true, data: subscription });
  } catch (err) {
    return safeError(err, res);
  }
};

// ─── Checkout ─────────────────────────────────────────────────────────────────

/**
 * POST /api/billing/checkout
 * Body: { plan_name: "basic" | "standard" | "premium", success_url, cancel_url, interval?: "month" | "year", coupon_code? }
 */
export const createCheckout = async (req, res) => {
  try {
    const plan_name =
      req.body?.plan_name ?? req.body?.planName ?? null;
    const success_url =
      req.body?.success_url ?? req.body?.successUrl ?? null;
    const cancel_url =
      req.body?.cancel_url ?? req.body?.cancelUrl ?? null;
    const coupon_code =
      req.body?.coupon_code ?? req.body?.couponCode ?? null;
    const interval =
      (req.body?.interval ?? req.body?.billing_interval) === "year"
        ? "year"
        : "month";

    if (!plan_name || !success_url || !cancel_url) {
      return res.status(400).json({
        code: 400,
        success: false,
        message: "plan_name, success_url, and cancel_url are required",
      });
    }

    const validPlans = ["basic", "standard", "premium"];
    if (!validPlans.includes(plan_name)) {
      return res.status(400).json({
        code: 400,
        success: false,
        message: `plan_name must be one of: ${validPlans.join(", ")}`,
      });
    }

    const session = await stripeService.createCheckoutSession({
      userId: req.user._id,
      planName: plan_name,
      successUrl: success_url,
      cancelUrl: cancel_url,
      couponCode: coupon_code,
      interval,
    });

    return res.status(200).json({
      code: 200,
      success: true,
      data: { checkout_url: session.url, session_id: session.id },
    });
  } catch (err) {
    return safeError(err, res);
  }
};

// ─── Billing Portal ───────────────────────────────────────────────────────────

/**
 * POST /api/billing/portal
 * Body: { return_url }
 */
export const createPortalSession = async (req, res) => {
  try {
    const { return_url } = req.body;
    if (!return_url) {
      return res
        .status(400)
        .json({ code: 400, success: false, message: "return_url is required" });
    }

    const session = await stripeService.createBillingPortalSession({
      userId: req.user._id,
      returnUrl: return_url,
    });

    return res.status(200).json({
      code: 200,
      success: true,
      data: { portal_url: session.url },
    });
  } catch (err) {
    return safeError(err, res);
  }
};

// ─── Cancel Subscription ──────────────────────────────────────────────────────

/**
 * POST /api/billing/cancel
 */
export const cancelSubscription = async (req, res) => {
  try {
    const subscription = await stripeService.cancelSubscription(req.user._id);
    return res.status(200).json({
      code: 200,
      success: true,
      message: "Subscription will be cancelled at the end of the billing period",
      data: subscription,
    });
  } catch (err) {
    return safeError(err, res);
  }
};

// ─── Change Plan (upgrade / downgrade) ───────────────────────────────────────

/**
 * POST /api/billing/change-plan
 * Body: { plan_name: "basic" | "standard" | "premium", interval?: "month" | "year" }
 */
export const changePlan = async (req, res) => {
  try {
    const { plan_name } = req.body;
    const interval = req.body.interval === "year" ? "year" : "month";
    if (!plan_name) {
      return res.status(400).json({ code: 400, success: false, message: "plan_name is required" });
    }

    const validPlans = ["basic", "standard", "premium"];
    if (!validPlans.includes(plan_name)) {
      return res.status(400).json({
        code: 400,
        success: false,
        message: `plan_name must be one of: ${validPlans.join(", ")}`,
      });
    }

    await stripeService.changePlan(req.user._id, plan_name, interval);

    // Fetch updated subscription to return
    const subscription = await stripeService.getActiveSubscription(req.user._id);
    return res.status(200).json({
      code: 200,
      success: true,
      message: `Plan changed to ${plan_name} successfully`,
      data: subscription,
    });
  } catch (err) {
    return safeError(err, res);
  }
};

// ─── Free Trial ──────────────────────────────────────────────────────────────

/**
 * POST /api/billing/free-trial
 * Authenticated – starts the 14-day free trial for the current user.
 */
export const startFreeTrial = async (req, res) => {
  try {
    const subscription = await stripeService.startFreeTrial(req.user._id);
    return res.status(200).json({ code: 200, success: true, data: subscription });
  } catch (err) {
    return safeError(err, res);
  }
};

// ─── Session Sync ─────────────────────────────────────────────────────────────

/**
 * POST /api/billing/sync-session
 * Body: { session_id }
 * Authenticated – retrieves a Stripe Checkout session and syncs the resulting
 * subscription into the DB. Used by the success page when webhooks haven't
 * arrived yet (e.g., local dev).
 */
export const syncSession = async (req, res) => {
  try {
    const { session_id } = req.body;
    if (!session_id) {
      return res.status(400).json({ code: 400, success: false, message: "session_id is required" });
    }
    const subscription = await stripeService.syncFromCheckoutSession(session_id, req.user._id);
    if (!subscription) {
      return res.status(404).json({ code: 404, success: false, message: "Subscription not found for this session" });
    }
    return res.status(200).json({ code: 200, success: true, data: subscription });
  } catch (err) {
    return safeError(err, res);
  }
};

// ─── Webhook ──────────────────────────────────────────────────────────────────

/**
 * POST /api/billing/webhook
 * Must receive the RAW body (configured in app.js before express.json()).
 */
export const stripeWebhook = async (req, res) => {
  const signature = req.headers["stripe-signature"];

  if (!signature) {
    return res
      .status(400)
      .json({ code: 400, success: false, message: "Missing stripe-signature header" });
  }

  try {
    await stripeService.handleWebhookEvent(req.body, signature);
    return res.status(200).json({ received: true });
  } catch (err) {
    const code = err.statusCode || 500;
    return res.status(code).json({ code, success: false, message: err.message });
  }
};
