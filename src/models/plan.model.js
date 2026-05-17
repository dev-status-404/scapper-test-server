import mongoose from "mongoose";

/**
 * Plan model – represents the subscription tiers available.
 * Seeded once via scripts/seedPlans.js
 *
 * max_smtp_domains / max_campaigns: -1 means unlimited
 * credits_per_cycle: leads that can be scraped per billing cycle
 * Each paid plan stores two Stripe Price IDs – one for monthly, one for annual.
 */
const planSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      enum: ["free_trial", "basic", "standard", "premium"],
      lowercase: true,
      trim: true,
    },
    display_name: {
      type: String,
      required: true,
      trim: true,
    },
    stripe_product_id: {
      type: String,
      default: null,
    },
    // Monthly Stripe Price ID
    stripe_price_id: {
      type: String,
      default: null,
    },
    // Annual Stripe Price ID
    stripe_price_id_annual: {
      type: String,
      default: null,
    },
    // price in cents (EUR) for monthly billing
    price_cents: {
      type: Number,
      required: true,
      min: 0,
    },
    // price in cents (EUR) for annual billing (full year, not per-month)
    price_cents_annual: {
      type: Number,
      default: 0,
      min: 0,
    },
    interval: {
      type: String,
      enum: ["month", "year", "one_time", "trial"],
      default: "month",
    },
    credits_per_cycle: {
      type: Number,
      required: true,
      min: 0,
    },
    // -1 = unlimited
    max_smtp_domains: {
      type: Number,
      required: true,
    },
    // -1 = unlimited
    max_campaigns: {
      type: Number,
      required: true,
    },
    trial_days: {
      type: Number,
      default: 0,
    },
    is_active: {
      type: Boolean,
      default: true,
    },
    features: {
      type: [String],
      default: [],
    },
    features_extra: {
      // features shown in "What's included" section
      type: [String],
      default: [],
    },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  }
);

planSchema.index({ name: 1 }, { unique: true });
planSchema.index({ stripe_price_id: 1 });
planSchema.index({ stripe_price_id_annual: 1 });

const Plan = mongoose.model("Plan", planSchema);

export default Plan;
