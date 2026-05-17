import { stripeService } from "../services/stripeService.js";
import Plan from "../models/plan.model.js";
import Subscription from "../models/subscription.model.js";
import Campaign from "../models/campaign.model.js";
import UserSmtpAccount from "../models/userSmtpAccount.model.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const forbidden = (res, message) =>
  res.status(403).json({ code: 403, success: false, message });

const paymentRequired = (res, message) =>
  res.status(402).json({ code: 402, success: false, message });

// ─── requireActiveSubscription ───────────────────────────────────────────────

/**
 * Ensures the user has an active subscription or active trial.
 * Attaches `req.subscription` (populated with plan) for downstream use.
 *
 * Usage: router.use(requireActiveSubscription)
 */
export const requireActiveSubscription = async (req, res, next) => {
  try {
    const userId = req.user?._id;
    if (!userId) return forbidden(res, "Authentication required");

    const subscription = await stripeService.getActiveSubscription(userId);

    if (!subscription) {
      return paymentRequired(
        res,
        "No active subscription. Please choose a plan to continue."
      );
    }

    // Check if trial expired (DB cron may not have fired yet)
    if (subscription.status === "trialing" && subscription.trial_end) {
      if (new Date() > subscription.trial_end) {
        subscription.status = "canceled";
        await subscription.save();
        return paymentRequired(
          res,
          "Your free trial has expired. Please subscribe to continue."
        );
      }
    }

    req.subscription = subscription;
    req.plan = subscription.plan_id; // populated Plan doc
    next();
  } catch (err) {
    next(err);
  }
};

// ─── requireCredits ──────────────────────────────────────────────────────────

/**
 * Ensures the user has enough credits before a scraping action.
 * Deducts `creditsNeeded` credits atomically on success.
 *
 * Usage: router.post("/scrape", auth(), requireActiveSubscription, requireCredits(1), handler)
 *
 * To defer actual deduction (e.g. wait until lead is saved), pass `deductNow: false`
 * and call `stripeService.deductCredits(userId, n)` manually in the service.
 */
export const requireCredits =
  (creditsNeeded = 1, deductNow = true) =>
  async (req, res, next) => {
    try {
      const sub = req.subscription;
      if (!sub) return forbidden(res, "Subscription check required");

      const remaining = sub.credits_total - sub.credits_used;
      if (remaining < creditsNeeded) {
        return paymentRequired(
          res,
          `Insufficient credits. You have ${remaining} credit(s) remaining on your plan.`
        );
      }

      if (deductNow) {
        await stripeService.deductCredits(req.user._id, creditsNeeded);
      }

      next();
    } catch (err) {
      if (err.statusCode === 402) return paymentRequired(res, err.message);
      next(err);
    }
  };

// ─── requireCampaignSlot ─────────────────────────────────────────────────────

/**
 * Checks whether the user is allowed to create another campaign.
 * Basic plan: max 3 active/draft campaigns.
 * Standard / Premium / Trial (same as Basic limits for trial): unlimited.
 *
 * Usage: router.post("/campaign", auth(), requireActiveSubscription, requireCampaignSlot, handler)
 */
export const requireCampaignSlot = async (req, res, next) => {
  try {
    const plan = req.plan;
    if (!plan) return forbidden(res, "Subscription check required");

    // -1 = unlimited
    if (plan.max_campaigns === -1) return next();

    const existingCount = await Campaign.countDocuments({
      user_id: req.user._id,
      is_deleted: { $ne: true },
      status: { $nin: ["SENT", "CANCELLED"] },
    });

    if (existingCount >= plan.max_campaigns) {
      return forbidden(
        res,
        `Your plan allows a maximum of ${plan.max_campaigns} active campaign(s). ` +
          `Please upgrade your plan or remove an existing campaign.`
      );
    }

    next();
  } catch (err) {
    next(err);
  }
};

// ─── requireSmtpSlot ─────────────────────────────────────────────────────────

/**
 * Checks whether the user is allowed to add another SMTP domain.
 * Basic: 1, Standard: 2, Premium: unlimited.
 *
 * Usage: router.post("/smtp", auth(), requireActiveSubscription, requireSmtpSlot, handler)
 */
export const requireSmtpSlot = async (req, res, next) => {
  try {
    const plan = req.plan;
    if (!plan) return forbidden(res, "Subscription check required");

    // -1 = unlimited
    if (plan.max_smtp_domains === -1) return next();

    const existingCount = await UserSmtpAccount.countDocuments({
      user_id: req.user._id,
    });

    if (existingCount >= plan.max_smtp_domains) {
      return forbidden(
        res,
        `Your plan allows a maximum of ${plan.max_smtp_domains} SMTP domain(s). ` +
          `Please upgrade your plan to add more.`
      );
    }

    next();
  } catch (err) {
    next(err);
  }
};
