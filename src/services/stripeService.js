import Stripe from "stripe";
import Plan from "../models/plan.model.js";
import Subscription from "../models/subscription.model.js";
import User from "../models/user.model.js";

// Lazy-initialise the Stripe client so the module can be imported in
// environments where STRIPE_SECRET_KEY is not yet set (e.g. unit tests).
let _stripe = null;
const getStripe = () => {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error("STRIPE_SECRET_KEY environment variable is not set");
    }
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: "2023-10-16",
    });
  }
  return _stripe;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Resolve the active subscription for a user (populated with plan).
 */
const getActiveSubscription = async (userId) => {
  return Subscription.findOne({
    user_id: userId,
    status: { $in: ["trialing", "active", "past_due"] },
  }).populate("plan_id");
};

/**
 * Sync subscription document from a Stripe subscription object.
 * Creates or updates the document as needed.
 */
const syncFromStripeSubscription = async (stripeSub) => {
  const priceId = stripeSub.items.data[0]?.price?.id;
  // Search both monthly and annual price IDs
  const plan = await Plan.findOne({
    $or: [{ stripe_price_id: priceId }, { stripe_price_id_annual: priceId }],
  });
  if (!plan) {
    console.error(`[Stripe] No plan found for price: ${priceId}`);
    return null;
  }

  // Find the user by stripe_customer_id stored on user doc
  const user = await User.findOne({ stripe_customer_id: stripeSub.customer });
  if (!user) {
    console.error(`[Stripe] No user found for customer: ${stripeSub.customer}`);
    return null;
  }

  const periodStart = new Date(stripeSub.current_period_start * 1000);
  const periodEnd = new Date(stripeSub.current_period_end * 1000);
  const trialEnd = stripeSub.trial_end ? new Date(stripeSub.trial_end * 1000) : null;

  const existing = await Subscription.findOne({
    stripe_subscription_id: stripeSub.id,
  });

  if (existing) {
    // Only reset credits if entering a new billing cycle
    const isNewCycle =
      existing.current_period_start.getTime() !== periodStart.getTime();

    existing.plan_id = plan._id;
    existing.status = stripeSub.status;
    existing.current_period_start = periodStart;
    existing.current_period_end = periodEnd;
    existing.trial_end = trialEnd;
    existing.cancel_at_period_end = stripeSub.cancel_at_period_end;
    existing.credits_total = plan.credits_per_cycle;
    if (isNewCycle) {
      existing.credits_used = 0; // reset on new cycle
    }
    await existing.save();
    return existing;
  }

  const subscription = await Subscription.create({
    user_id: user._id,
    plan_id: plan._id,
    stripe_customer_id: stripeSub.customer,
    stripe_subscription_id: stripeSub.id,
    status: stripeSub.status,
    current_period_start: periodStart,
    current_period_end: periodEnd,
    trial_end: trialEnd,
    cancel_at_period_end: stripeSub.cancel_at_period_end,
    credits_total: plan.credits_per_cycle,
    credits_used: 0,
  });

  return subscription;
};

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Create (or retrieve) a Stripe customer for this user.
 */
const getOrCreateStripeCustomer = async (user) => {
  if (user.stripe_customer_id) {
    return user.stripe_customer_id;
  }

  const customer = await getStripe().customers.create({
    email: user.email,
    name: `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim() || user.email,
    metadata: { user_id: String(user._id) },
    currency: process.env.STRIPE_CURRENCY || "usd",
  });

  await User.findByIdAndUpdate(user._id, { stripe_customer_id: customer.id });
  return customer.id;
};

/**
 * Start the 14-day free trial for a newly registered user.
 * Does NOT touch Stripe – purely our own DB record.
 */
const startFreeTrial = async (userId) => {
  const plan = await Plan.findOne({ name: "free_trial" });
  if (!plan) throw new Error("free_trial plan not seeded in database");

  // Check if user already has any subscription
  const existing = await Subscription.findOne({ user_id: userId });
  if (existing) return existing;

  const now = new Date();
  const trialEnd = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  const subscription = await Subscription.create({
    user_id: userId,
    plan_id: plan._id,
    status: "trialing",
    current_period_start: now,
    current_period_end: trialEnd,
    trial_end: trialEnd,
    credits_total: plan.credits_per_cycle,
    credits_used: 0,
  });

  return subscription;
};

/**
 * Create a Stripe Checkout Session for upgrading/subscribing.
 * @param {string} couponCode - Optional Stripe promotion code to pre-apply
 * @param {"month"|"year"} interval - Billing interval (defaults to "month")
 */
const createCheckoutSession = async ({ userId, planName, successUrl, cancelUrl, couponCode, interval = "month" }) => {
  const plan = await Plan.findOne({ name: planName, is_active: true });
  if (!plan) throw new Error(`Plan "${planName}" not found`);

  // Select the correct Stripe price based on requested billing interval
  const priceId = interval === "year" && plan.stripe_price_id_annual
    ? plan.stripe_price_id_annual
    : plan.stripe_price_id;

  if (!priceId) {
    throw new Error(`Plan "${planName}" has no Stripe price configured for interval "${interval}"`);
  }

  const user = await User.findById(userId);
  if (!user) throw new Error("User not found");

  const customerId = await getOrCreateStripeCustomer(user);

  const sessionParams = {
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { user_id: String(userId), plan_name: planName, billing_interval: interval },
    subscription_data: {
      metadata: { user_id: String(userId), plan_name: planName, billing_interval: interval },
    },
    allow_promotion_codes: true,
  };

  // If a coupon code is provided, try to look up the promotion code and apply it
  if (couponCode) {
    try {
      const promoCodes = await getStripe().promotionCodes.list({
        code: couponCode,
        active: true,
        limit: 1,
      });
      if (promoCodes.data.length > 0) {
        sessionParams.discounts = [{ promotion_code: promoCodes.data[0].id }];
        // When using discounts, allow_promotion_codes must be removed
        delete sessionParams.allow_promotion_codes;
      }
    } catch (_err) {
      // Invalid coupon – ignore, Stripe checkout will still work without it
    }
  }

  const session = await getStripe().checkout.sessions.create(sessionParams);
  return session;
};

/**
 * Change a user's subscription plan (upgrade or downgrade).
 * For upgrades, the change is immediate and prorated.
 * For downgrades, the change takes effect at the end of the period.
 */
const changePlan = async (userId, newPlanName, interval = "month") => {
  const validPlans = ["basic", "standard", "premium"];
  if (!validPlans.includes(newPlanName)) {
    throw Object.assign(new Error(`Invalid plan: ${newPlanName}`), { statusCode: 400 });
  }

  const newPlan = await Plan.findOne({ name: newPlanName, is_active: true });
  const targetPriceId = interval === "year" && newPlan?.stripe_price_id_annual
    ? newPlan.stripe_price_id_annual
    : newPlan?.stripe_price_id;

  if (!targetPriceId) {
    throw Object.assign(new Error(`Plan "${newPlanName}" is not configured in Stripe`), { statusCode: 400 });
  }

  const subscription = await getActiveSubscription(userId);
  if (!subscription) {
    throw Object.assign(new Error("No active subscription to change"), { statusCode: 404 });
  }
  if (!subscription.stripe_subscription_id) {
    throw Object.assign(new Error("Cannot change plan on a free trial via this endpoint. Please subscribe first."), { statusCode: 400 });
  }

  const currentPlan = subscription.plan_id; // populated (may be null if plan doc missing)
  if (currentPlan?.name === newPlanName) {
    throw Object.assign(new Error("Already on this plan"), { statusCode: 400 });
  }

  const stripeSub = await getStripe().subscriptions.retrieve(subscription.stripe_subscription_id);
  const currentItemId = stripeSub.items.data[0]?.id;

  // Determine if upgrade or downgrade based on price ordering
  const planOrder = { basic: 1, standard: 2, premium: 3 };
  const isUpgrade = (planOrder[newPlanName] ?? 0) > (planOrder[currentPlan?.name] ?? 0);

  const updateParams = {
    items: [{ id: currentItemId, price: targetPriceId }],
    proration_behavior: isUpgrade ? "create_prorations" : "none",
  };

  if (!isUpgrade) {
    // Downgrade – apply at period end
    updateParams.billing_cycle_anchor = "unchanged";
  }

  const updatedSub = await getStripe().subscriptions.update(
    subscription.stripe_subscription_id,
    updateParams
  ).catch((err) => {
    if (err?.raw?.message?.includes("currency")) {
      throw Object.assign(
        new Error(
          `Currency mismatch: the "${newPlanName}" plan price is configured in a different currency than your subscription. ` +
          `Please update the plan's Stripe price ID to a ${(process.env.STRIPE_CURRENCY || "usd").toUpperCase()} price in the admin panel.`
        ),
        { statusCode: 400 }
      );
    }
    throw err;
  });

  // Sync locally
  await syncFromStripeSubscription(updatedSub);

  return updatedSub;
};

/**
 * Create a Stripe Customer Portal session so users can manage billing.
 */
const createBillingPortalSession = async ({ userId, returnUrl }) => {
  const user = await User.findById(userId);
  if (!user) throw new Error("User not found");

  if (!user.stripe_customer_id) {
    throw new Error("No Stripe customer associated with this account");
  }

  const session = await getStripe().billingPortal.sessions.create({
    customer: user.stripe_customer_id,
    return_url: returnUrl,
  });

  return session;
};

/**
 * Cancel a subscription at the end of the current period.
 */
const cancelSubscription = async (userId) => {
  const subscription = await getActiveSubscription(userId);
  if (!subscription) throw new Error("No active subscription found");
  if (!subscription.stripe_subscription_id) {
    throw new Error("Cannot cancel a free-trial from this endpoint");
  }

  await getStripe().subscriptions.update(subscription.stripe_subscription_id, {
    cancel_at_period_end: true,
  });

  subscription.cancel_at_period_end = true;
  await subscription.save();

  return subscription;
};

/**
 * Deduct credits from the user's active subscription (atomically).
 * Returns the updated subscription or throws if not enough credits.
 */
const deductCredits = async (userId, amount = 1) => {
  const subscription = await getActiveSubscription(userId);
  if (!subscription) {
    throw Object.assign(new Error("No active subscription"), { statusCode: 403 });
  }

  const remaining = subscription.credits_total - subscription.credits_used;
  if (remaining < amount) {
    throw Object.assign(
      new Error(`Insufficient credits. You have ${remaining} credit(s) remaining.`),
      { statusCode: 402 }
    );
  }

  // Atomic increment to prevent race conditions
  const updated = await Subscription.findOneAndUpdate(
    {
      _id: subscription._id,
      // Optimistic lock: only update if still has enough credits
      $expr: { $gte: [{ $subtract: ["$credits_total", "$credits_used"] }, amount] },
    },
    { $inc: { credits_used: amount } },
    { new: true }
  );

  if (!updated) {
    throw Object.assign(
      new Error("Insufficient credits (concurrent request detected)."),
      { statusCode: 402 }
    );
  }

  return updated;
};

/**
 * Return unused credits to the user's active subscription.
 * Used when a job reserves credits for scraped profiles but saves fewer leads.
 */
const refundCredits = async (userId, amount = 1) => {
  const creditAmount = Math.max(0, Number(amount) || 0);
  if (creditAmount === 0) {
    return getActiveSubscription(userId);
  }

  const subscription = await getActiveSubscription(userId);
  if (!subscription) {
    throw Object.assign(new Error("No active subscription"), { statusCode: 403 });
  }

  return Subscription.findOneAndUpdate(
    { _id: subscription._id },
    [
      {
        $set: {
          credits_used: {
            $max: [0, { $subtract: ["$credits_used", creditAmount] }],
          },
        },
      },
    ],
    { new: true }
  );
};

// ─── Webhook Handler ─────────────────────────────────────────────────────────

/**
 * Process a Stripe webhook event.
 * @param {string} rawBody - The raw request body (Buffer or string)
 * @param {string} signature - Value of `stripe-signature` header
 */
const handleWebhookEvent = async (rawBody, signature) => {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new Error("STRIPE_WEBHOOK_SECRET environment variable is not set");
  }

  let event;
  try {
    event = getStripe().webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    throw Object.assign(new Error(`Webhook signature verification failed: ${err.message}`), {
      statusCode: 400,
    });
  }

  const { type, data } = event;

  switch (type) {
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      await syncFromStripeSubscription(data.object);
      break;
    }

    case "customer.subscription.deleted": {
      const stripeSub = data.object;
      await Subscription.findOneAndUpdate(
        { stripe_subscription_id: stripeSub.id },
        { status: "canceled" }
      );
      break;
    }

    case "invoice.payment_succeeded": {
      const invoice = data.object;
      if (invoice.subscription) {
        const stripeSub = await getStripe().subscriptions.retrieve(invoice.subscription);
        await syncFromStripeSubscription(stripeSub);
      }
      break;
    }

    case "invoice.payment_failed": {
      const invoice = data.object;
      if (invoice.subscription) {
        await Subscription.findOneAndUpdate(
          { stripe_subscription_id: invoice.subscription },
          { status: "past_due" }
        );
      }
      break;
    }

    case "checkout.session.completed": {
      // Eagerly sync the subscription so it's available before
      // customer.subscription.created arrives (handles local dev without CLI).
      const session = data.object;
      if (session.subscription) {
        const stripeSub = await getStripe().subscriptions.retrieve(session.subscription);
        await syncFromStripeSubscription(stripeSub);
      }
      break;
    }

    default:
      // Unhandled event types – ignored intentionally
      break;
  }

  return event;
};

/**
 * Sync subscription from a Stripe Checkout session ID.
 * Used by the success page to force-sync before webhooks arrive.
 * Verifies the session belongs to the given userId.
 */
const syncFromCheckoutSession = async (sessionId, userId) => {
  const session = await getStripe().checkout.sessions.retrieve(sessionId);
  if (!session) throw Object.assign(new Error("Session not found"), { statusCode: 404 });

  // Security: ensure this session belongs to the requesting user
  if (String(session.metadata?.user_id) !== String(userId)) {
    throw Object.assign(new Error("Session does not belong to this user"), { statusCode: 403 });
  }

  if (!session.subscription) {
    throw Object.assign(new Error("No subscription found in this session"), { statusCode: 404 });
  }

  const stripeSub = await getStripe().subscriptions.retrieve(session.subscription);
  return syncFromStripeSubscription(stripeSub);
};

// ─── Scheduled job helper ────────────────────────────────────────────────────

/**
 * Expire free trials that have passed their trial_end date.
 * Call this from your cron service.
 */
const expireTrials = async () => {
  const result = await Subscription.updateMany(
    {
      status: "trialing",
      trial_end: { $lt: new Date() },
      stripe_subscription_id: null, // only pure free-trial records
    },
    { status: "canceled" }
  );
  return result.modifiedCount;
};

export const stripeService = {
  getActiveSubscription,
  startFreeTrial,
  createCheckoutSession,
  createBillingPortalSession,
  cancelSubscription,
  changePlan,
  deductCredits,
  refundCredits,
  handleWebhookEvent,
  expireTrials,
  getOrCreateStripeCustomer,
  syncFromCheckoutSession,
};
