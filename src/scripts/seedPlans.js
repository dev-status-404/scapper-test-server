#!/usr/bin/env node

/**
 * Seed Script: Create subscription plans in the database.
 *
 * Usage:
 *   node src/scripts/seedPlans.js
 *
 * Automatically creates Stripe products and prices if STRIPE_SECRET_KEY is set.
 */

import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

const PLANS = [
  {
    name: "free_trial",
    display_name: "Free Trial",
    stripe_product_id: null,
    stripe_price_id: null,
    stripe_price_id_annual: null,
    price_cents: 0,
    price_cents_annual: 0,
    interval: "trial",
    credits_per_cycle: 100,
    max_smtp_domains: 1,
    max_campaigns: 3,
    trial_days: 14,
    is_active: true,
    features: [
      "100 profile credits",
      "1 SMTP domain",
      "Up to 3 campaigns",
      "14-day trial",
    ],
    features_extra: [],
  },
  {
    name: "basic",
    display_name: "Basic",
    stripe_product_id: process.env.STRIPE_BASIC_PRODUCT_ID || null,
    stripe_price_id: process.env.STRIPE_BASIC_PRICE_ID || null,
    stripe_price_id_annual: process.env.STRIPE_BASIC_PRICE_ID_ANNUAL || null,
    price_cents: 2900,
    price_cents_annual: 29000,
    interval: "month",
    credits_per_cycle: 500,
    max_smtp_domains: 1,
    max_campaigns: 3,
    trial_days: 0,
    is_active: true,
    features: [
      "500 profile credits / month",
      "1 SMTP domain",
      "Up to 3 campaigns",
      "Email support",
    ],
    features_extra: [],
  },
  {
    name: "standard",
    display_name: "Standard",
    stripe_product_id: process.env.STRIPE_STANDARD_PRODUCT_ID || null,
    stripe_price_id: process.env.STRIPE_STANDARD_PRICE_ID || null,
    stripe_price_id_annual: process.env.STRIPE_STANDARD_PRICE_ID_ANNUAL || null,
    price_cents: 7900,
    price_cents_annual: 79000,
    interval: "month",
    credits_per_cycle: 2000,
    max_smtp_domains: 2,
    max_campaigns: -1,
    trial_days: 0,
    is_active: true,
    features: [
      "2,000 profile credits / month",
      "2 SMTP domains",
      "Unlimited campaigns",
      "Priority support",
    ],
    features_extra: [],
  },
  {
    name: "premium",
    display_name: "Premium",
    stripe_product_id: process.env.STRIPE_PREMIUM_PRODUCT_ID || null,
    stripe_price_id: process.env.STRIPE_PREMIUM_PRICE_ID || null,
    stripe_price_id_annual: process.env.STRIPE_PREMIUM_PRICE_ID_ANNUAL || null,
    price_cents: 19900,
    price_cents_annual: 199000,
    interval: "month",
    credits_per_cycle: 10000,
    max_smtp_domains: -1,
    max_campaigns: -1,
    trial_days: 0,
    is_active: true,
    features: [
      "10,000 profile credits / month",
      "Unlimited SMTP domains",
      "Unlimited campaigns",
      "Dedicated support",
    ],
    features_extra: [],
  },
];

async function createStripeProductAndPrices(stripe, plan) {
  const currency = process.env.STRIPE_CURRENCY || "usd";

  const product = await stripe.products.create({
    name: plan.display_name,
    metadata: { plan_name: plan.name },
  });
  console.log(`    → Stripe product created: ${product.id}`);

  const monthlyPrice = await stripe.prices.create({
    product: product.id,
    unit_amount: plan.price_cents,
    currency,
    recurring: { interval: "month" },
    metadata: { plan_name: plan.name, billing: "monthly" },
  });
  console.log(`    → Monthly price created: ${monthlyPrice.id}`);

  const annualPrice = await stripe.prices.create({
    product: product.id,
    unit_amount: plan.price_cents_annual,
    currency,
    recurring: { interval: "year" },
    metadata: { plan_name: plan.name, billing: "annual" },
  });
  console.log(`    → Annual price created: ${annualPrice.id}`);

  return {
    stripe_product_id: product.id,
    stripe_price_id: monthlyPrice.id,
    stripe_price_id_annual: annualPrice.id,
  };
}

async function seed() {
  console.log("🌱 Plan Seed Script\n");

  let stripe = null;
  if (process.env.STRIPE_SECRET_KEY) {
    const { default: Stripe } = await import("stripe");
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    console.log("✓ Stripe connected\n");
  } else {
    console.log("⚠ No STRIPE_SECRET_KEY — skipping Stripe product creation\n");
  }

  try {
    const { default: Plan } = await import("../models/plan.model.js");

    console.log("📡 Connecting to database...");
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
    console.log("✓ Connected\n");

    let created = 0;
    let updated = 0;

    for (const planData of PLANS) {
      // Auto-create Stripe product+prices for paid plans that have no IDs yet
      if (stripe && planData.price_cents > 0 && !planData.stripe_product_id) {
        console.log(`  💳 Creating Stripe product for: ${planData.display_name}`);
        try {
          const stripeIds = await createStripeProductAndPrices(stripe, planData);
          Object.assign(planData, stripeIds);
        } catch (stripeErr) {
          console.warn(`    ⚠ Stripe error: ${stripeErr.message}`);
        }
      }

      const existing = await Plan.findOne({ name: planData.name });

      if (existing) {
        Object.assign(existing, planData);
        await existing.save();
        console.log(`  ↺ Updated: ${planData.display_name} (${planData.name})`);
        updated++;
      } else {
        await Plan.create(planData);
        console.log(`  ✓ Created: ${planData.display_name} (${planData.name})`);
        created++;
      }
    }

    console.log("\n" + "=".repeat(50));
    console.log("📊 Seed Summary:");
    console.log(`  ✓ Created: ${created} plan(s)`);
    console.log(`  ↺ Updated: ${updated} plan(s)`);
    console.log("=".repeat(50));
  } catch (err) {
    console.error("\n❌ Seed failed:", err.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log("\n👋 Disconnected from database");
  }
}

seed();
