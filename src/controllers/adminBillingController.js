/**
 * adminBillingController.js
 *
 * Admin-only billing management endpoints:
 *  – List all user subscriptions (paginated)
 *  – Cancel a specific user's subscription immediately
 *  – Issue a (partial or full) refund on a Stripe charge
 *  – List, create, and deactivate Stripe promotion codes / coupons
 */

import Stripe from "stripe";
import Subscription from "../models/subscription.model.js";
import User from "../models/user.model.js";
import Plan from "../models/plan.model.js";

let _stripe = null;
const getStripe = () => {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY not set");
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });
  }
  return _stripe;
};

const safeError = (err, res) => {
  const code = err.statusCode || 500;
  console.error("[AdminBilling]", err.message);
  return res.status(code).json({ code, success: false, message: err.message || "Something went wrong" });
};

// ─── Subscriptions ────────────────────────────────────────────────────────────

/**
 * GET /api/admin/billing/subscriptions
 * Query: { page=1, limit=20, search?, status? }
 *
 * Returns all user subscriptions with user email + plan info.
 */
export const adminListSubscriptions = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    const { search, status } = req.query;

    // Build match filter
    const filter = {};
    if (status) filter.status = status;

    // If searching by email, find matching user IDs first
    if (search) {
      const users = await User.find({
        $or: [
          { email: { $regex: search, $options: "i" } },
          { first_name: { $regex: search, $options: "i" } },
          { last_name: { $regex: search, $options: "i" } },
        ],
      }).select("_id");
      filter.user_id = { $in: users.map((u) => u._id) };
    }

    const [subscriptions, total] = await Promise.all([
      Subscription.find(filter)
        .populate("user_id", "email first_name last_name stripe_customer_id")
        .populate("plan_id", "name display_name price_cents price_cents_annual")
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Subscription.countDocuments(filter),
    ]);

    return res.status(200).json({
      code: 200,
      success: true,
      data: subscriptions,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    return safeError(err, res);
  }
};

/**
 * POST /api/admin/billing/subscriptions/:userId/cancel
 * Immediately cancels the user's active Stripe subscription.
 */
export const adminCancelSubscription = async (req, res) => {
  try {
    const { userId } = req.params;

    const subscription = await Subscription.findOne({
      user_id: userId,
      status: { $in: ["active", "trialing", "past_due"] },
    });

    if (!subscription) {
      return res.status(404).json({ code: 404, success: false, message: "No active subscription found for this user" });
    }

    if (subscription.stripe_subscription_id) {
      // Cancel immediately in Stripe
      await getStripe().subscriptions.cancel(subscription.stripe_subscription_id);
    }

    subscription.status = "canceled";
    subscription.cancel_at_period_end = false;
    await subscription.save();

    return res.status(200).json({
      code: 200,
      success: true,
      message: "Subscription cancelled immediately",
      data: subscription,
    });
  } catch (err) {
    return safeError(err, res);
  }
};

// ─── Refunds ──────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/billing/charges
 * Query: { customer_id?, limit=10, starting_after? }
 *
 * Lists recent Stripe charges (to find charge IDs for refunds).
 */
export const adminListCharges = async (req, res) => {
  try {
    const { customer_id, limit = 10, starting_after } = req.query;

    const params = {
      limit: Math.min(100, parseInt(limit) || 10),
    };
    if (customer_id) params.customer = customer_id;
    if (starting_after) params.starting_after = starting_after;

    const charges = await getStripe().charges.list(params);

    return res.status(200).json({
      code: 200,
      success: true,
      data: charges.data.map((c) => ({
        id: c.id,
        amount: c.amount,
        amount_refunded: c.amount_refunded,
        currency: c.currency,
        status: c.status,
        refunded: c.refunded,
        customer: c.customer,
        description: c.description,
        created: c.created,
        receipt_url: c.receipt_url,
      })),
      has_more: charges.has_more,
    });
  } catch (err) {
    return safeError(err, res);
  }
};

/**
 * POST /api/admin/billing/refund
 * Body: { charge_id, amount? }  — amount in cents; omit for full refund
 */
export const adminIssueRefund = async (req, res) => {
  try {
    const { charge_id, amount, reason } = req.body;

    if (!charge_id) {
      return res.status(400).json({ code: 400, success: false, message: "charge_id is required" });
    }

    const refundParams = { charge: charge_id };
    if (amount) {
      const parsed = parseInt(amount);
      if (isNaN(parsed) || parsed <= 0) {
        return res.status(400).json({ code: 400, success: false, message: "amount must be a positive integer (cents)" });
      }
      refundParams.amount = parsed;
    }
    if (reason && ["duplicate", "fraudulent", "requested_by_customer"].includes(reason)) {
      refundParams.reason = reason;
    }

    const refund = await getStripe().refunds.create(refundParams);

    return res.status(200).json({
      code: 200,
      success: true,
      message: "Refund issued successfully",
      data: {
        id: refund.id,
        amount: refund.amount,
        currency: refund.currency,
        status: refund.status,
        charge: refund.charge,
        reason: refund.reason,
        created: refund.created,
      },
    });
  } catch (err) {
    return safeError(err, res);
  }
};

// ─── Promo Codes / Coupons ────────────────────────────────────────────────────

/**
 * GET /api/admin/billing/promo-codes
 * Query: { active?, limit=20 }
 */
export const adminListPromoCodes = async (req, res) => {
  try {
    const { active, limit = 20 } = req.query;

    const params = { limit: Math.min(100, parseInt(limit) || 20), expand: ["data.coupon"] };
    if (active === "true") params.active = true;
    if (active === "false") params.active = false;

    const promoCodes = await getStripe().promotionCodes.list(params);

    return res.status(200).json({
      code: 200,
      success: true,
      data: promoCodes.data.map((pc) => ({
        id: pc.id,
        code: pc.code,
        active: pc.active,
        times_redeemed: pc.times_redeemed,
        max_redemptions: pc.max_redemptions,
        expires_at: pc.expires_at,
        coupon: {
          id: pc.coupon.id,
          name: pc.coupon.name,
          percent_off: pc.coupon.percent_off,
          amount_off: pc.coupon.amount_off,
          currency: pc.coupon.currency,
          duration: pc.coupon.duration,
          duration_in_months: pc.coupon.duration_in_months,
          times_redeemed: pc.coupon.times_redeemed,
          valid: pc.coupon.valid,
        },
      })),
      has_more: promoCodes.has_more,
    });
  } catch (err) {
    return safeError(err, res);
  }
};

/**
 * POST /api/admin/billing/promo-codes
 * Body: {
 *   code,              — promo code string (e.g. "SUMMER25")
 *   percent_off?,      — 1–100
 *   amount_off?,       — cents, requires currency
 *   currency?,         — e.g. "eur"
 *   duration,          — "once" | "repeating" | "forever"
 *   duration_in_months?, — required when duration="repeating"
 *   max_redemptions?,
 *   expires_at?,       — unix timestamp or ISO date string
 *   name?              — internal coupon name
 * }
 */
export const adminCreatePromoCode = async (req, res) => {
  try {
    const {
      code,
      percent_off,
      amount_off,
      currency,
      duration = "once",
      duration_in_months,
      max_redemptions,
      expires_at,
      name,
    } = req.body;

    if (!code) {
      return res.status(400).json({ code: 400, success: false, message: "code is required" });
    }
    if (!percent_off && !amount_off) {
      return res.status(400).json({ code: 400, success: false, message: "Either percent_off or amount_off is required" });
    }
    if (!["once", "repeating", "forever"].includes(duration)) {
      return res.status(400).json({ code: 400, success: false, message: "duration must be once, repeating, or forever" });
    }

    // Create the coupon first
    const couponParams = {
      duration,
      name: name || code,
    };
    if (percent_off) couponParams.percent_off = parseFloat(percent_off);
    if (amount_off) {
      couponParams.amount_off = parseInt(amount_off);
      couponParams.currency = currency || process.env.STRIPE_CURRENCY || "usd";
    }
    if (duration === "repeating" && duration_in_months) {
      couponParams.duration_in_months = parseInt(duration_in_months);
    }

    const coupon = await getStripe().coupons.create(couponParams);

    // Create the promotion code
    const promoParams = { coupon: coupon.id, code: code.toUpperCase() };
    if (max_redemptions) promoParams.max_redemptions = parseInt(max_redemptions);
    if (expires_at) {
      const ts = typeof expires_at === "string" ? Math.floor(new Date(expires_at).getTime() / 1000) : expires_at;
      promoParams.expires_at = ts;
    }

    const promoCode = await getStripe().promotionCodes.create(promoParams);

    return res.status(201).json({
      code: 201,
      success: true,
      message: "Promotion code created",
      data: {
        id: promoCode.id,
        code: promoCode.code,
        active: promoCode.active,
        coupon_id: coupon.id,
        percent_off: coupon.percent_off,
        amount_off: coupon.amount_off,
        currency: coupon.currency,
        duration: coupon.duration,
        max_redemptions: promoCode.max_redemptions,
        expires_at: promoCode.expires_at,
      },
    });
  } catch (err) {
    return safeError(err, res);
  }
};

/**
 * PATCH /api/admin/billing/promo-codes/:promoCodeId/deactivate
 * Deactivates a promotion code (cannot be re-activated via API).
 */
export const adminDeactivatePromoCode = async (req, res) => {
  try {
    const { promoCodeId } = req.params;

    const promoCode = await getStripe().promotionCodes.update(promoCodeId, { active: false });

    return res.status(200).json({
      code: 200,
      success: true,
      message: "Promotion code deactivated",
      data: { id: promoCode.id, code: promoCode.code, active: promoCode.active },
    });
  } catch (err) {
    return safeError(err, res);
  }
};
