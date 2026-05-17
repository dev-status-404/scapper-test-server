import mongoose from "mongoose";

/**
 * Subscription model – tracks the active subscription for each user.
 * One active subscription per user at any time.
 *
 * status mirrors Stripe statuses + "trialing" for free-trial users
 * who have not gone through Stripe at all.
 */
const subscriptionSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    plan_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Plan",
      required: true,
    },
    // Stripe IDs (null for free-trial users who haven't subscribed yet)
    stripe_customer_id: {
      type: String,
      default: null,
    },
    stripe_subscription_id: {
      type: String,
      default: null,
      sparse: true,
    },
    stripe_invoice_id: {
      type: String,
      default: null,
    },
    // Mirrors Stripe subscription status.
    // "trialing" is also used for users on the 14-day free trial (no Stripe).
    status: {
      type: String,
      enum: [
        "trialing",
        "active",
        "past_due",
        "canceled",
        "unpaid",
        "incomplete",
        "incomplete_expired",
        "paused",
      ],
      default: "trialing",
      index: true,
    },
    current_period_start: {
      type: Date,
      required: true,
    },
    current_period_end: {
      type: Date,
      required: true,
    },
    trial_end: {
      type: Date,
      default: null,
    },
    cancel_at_period_end: {
      type: Boolean,
      default: false,
    },
    // Credits management
    credits_total: {
      type: Number,
      required: true,
      min: 0,
    },
    credits_used: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  }
);

subscriptionSchema.index({ user_id: 1, status: 1 });
subscriptionSchema.index({ stripe_subscription_id: 1 }, { sparse: true });
subscriptionSchema.index({ stripe_customer_id: 1 }, { sparse: true });

/** Remaining credits for this billing cycle */
subscriptionSchema.virtual("credits_remaining").get(function () {
  return Math.max(0, this.credits_total - this.credits_used);
});

/**
 * Returns true when the subscription should be considered "access-granting".
 * Trialing, active, and past_due (grace period) all allow access.
 */
subscriptionSchema.virtual("is_access_granted").get(function () {
  return ["trialing", "active", "past_due"].includes(this.status);
});

subscriptionSchema.set("toJSON", { virtuals: true });
subscriptionSchema.set("toObject", { virtuals: true });

const Subscription = mongoose.model("Subscription", subscriptionSchema);

export default Subscription;
