/**
 * scripts/seedPlans.js
 *
 * Seeds the three paid tiers + free-trial into MongoDB and creates the
 * corresponding Stripe Products/Prices (monthly AND annual for paid plans).
 *
 * Pricing (USD):
 *   Basic    – $97/mo  | $1,046/yr  (10 % off)
 *   Standard – $297/mo | $3,206/yr  (10 % off)
 *   Premium  – $997/mo | $10,766/yr (10 % off)
 *
 * Usage (from project root):
 *   cd scapper-backend && node scripts/seedPlans.js
 *
 * Re-running is safe – existing plans are updated in-place; Stripe prices are
 * recreated only when missing or in the wrong currency.
 */

import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import Stripe from "stripe";
import Plan from "../src/models/plan.model.js";

// ─── Env checks ───────────────────────────────────────────────────────────────

const { MONGODB_URI, STRIPE_SECRET_KEY } = process.env;
const CURRENCY = (process.env.STRIPE_CURRENCY || "usd").toLowerCase();

if (!MONGODB_URI) { console.error("❌  MONGODB_URI is not set"); process.exit(1); }
if (!STRIPE_SECRET_KEY) { console.error("❌  STRIPE_SECRET_KEY is not set"); process.exit(1); }

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });

// ─── Plan definitions ─────────────────────────────────────────────────────────

const PLAN_DEFINITIONS = [
  // ── Free trial ──────────────────────────────────────────────────────────────
  {
    name: "free_trial",
    display_name: "Free Trial",
    price_cents: 0,
    price_cents_annual: 0,
    interval: "trial",
    credits_per_cycle: 500,
    max_smtp_domains: 1,
    max_campaigns: 3,
    trial_days: 14,
    features: [
      "500 credits/month",
      "1 email account",
      "500 emails/month",
      "3 campaigns",
      "14-day free trial",
    ],
    features_extra: [
      "Automatic prospecting tool",
      "Advanced segmentation",
      "Data export",
    ],
  },

  // ── Basic ───────────────────────────────────────────────────────────────────
  {
    name: "basic",
    display_name: "Basic",
    description: "Perfect for small businesses and freelancers",
    price_cents: 9700,          // $97 / month
    price_cents_annual: 104600, // $1,046 / year (saves $115 vs 12 × $97)
    interval: "month",
    credits_per_cycle: 10000,
    max_smtp_domains: 10,
    max_campaigns: 6,
    trial_days: 0,
    features: [
      "10,000 credits/month",
      "10 email accounts",
      "4,000 emails/month",
      "6 campaigns",
    ],
    features_extra: [
      "Automatic prospecting tool",
      "Advanced segmentation",
      "Data export",
      "Anti-ban protection",
      "Email Sender®",
      "Proven Templates",
    ],
  },

  // ── Standard ─────────────────────────────────────────────────────────────────
  {
    name: "standard",
    display_name: "Standard",
    description: "For growing teams with advanced needs",
    price_cents: 29700,          // $297 / month
    price_cents_annual: 320600,  // $3,206 / year (saves $355 vs 12 × $297)
    interval: "month",
    credits_per_cycle: 40000,
    max_smtp_domains: 30,
    max_campaigns: 12,
    trial_days: 0,
    features: [
      "40,000 credits/month",
      "30 email accounts",
      "10,000 emails/month",
      "12 campaigns",
    ],
    features_extra: [
      "Everything in Basic, plus:",
      "Auto Enrich",
      "AI Writing Assistant",
      "Community Access",
      "Followed users",
      "Email Verifier",
      "Warming up emails",
    ],
  },

  // ── Premium ──────────────────────────────────────────────────────────────────
  {
    name: "premium",
    display_name: "Premium",
    description: "For agencies and power users",
    price_cents: 99700,           // $997 / month
    price_cents_annual: 1076600,  // $10,766 / year (saves $1,195 vs 12 × $997)
    interval: "month",
    credits_per_cycle: 9999999,
    max_smtp_domains: -1,
    max_campaigns: -1,
    trial_days: 0,
    features: [
      "Unlimited credits/month",
      "Unlimited email accounts",
      "Unlimited emails/month",
      "Unlimited campaigns",
    ],
    features_extra: [
      "Everything in Standard, plus:",
      "Dedicated Success Manager",
      "Personalized training",
      "Project Workspace",
    ],
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function ensureStripeProduct(plan, existingProductId) {
  if (existingProductId) {
    try {
      return await stripe.products.retrieve(existingProductId);
    } catch {
      // product deleted in Stripe – create fresh
    }
  }
  return stripe.products.create({
    name: plan.display_name,
    description: plan.description ?? plan.display_name,
    metadata: { plan_name: plan.name },
  });
}

async function createStripePrice(productId, amountCents, interval, planName) {
  return stripe.prices.create({
    product: productId,
    unit_amount: amountCents,
    currency: CURRENCY,
    recurring: { interval },
    metadata: { plan_name: planName, billing_interval: interval },
  });
}

// Returns true if the existing Stripe price is NOT in the target currency
async function priceCurrencyMismatch(priceId) {
  if (!priceId) return false;
  try {
    const price = await stripe.prices.retrieve(priceId);
    return price.currency.toLowerCase() !== CURRENCY;
  } catch {
    return true; // price missing – treat as mismatch so it gets recreated
  }
}

// ─── Main seed ────────────────────────────────────────────────────────────────

async function seedPlans() {
  await mongoose.connect(MONGODB_URI);
  console.log(`✅  Connected to MongoDB`);
  console.log(`💱  Target currency: ${CURRENCY.toUpperCase()}\n`);

  for (const def of PLAN_DEFINITIONS) {
    console.log(`\n──────────────────────────────────────────`);
    console.log(`📦  Processing plan: ${def.display_name}`);

    let dbPlan = await Plan.findOne({ name: def.name });
    const isNew = !dbPlan;

    if (isNew) {
      dbPlan = new Plan({
        name: def.name,
        display_name: def.display_name,
        price_cents: def.price_cents,
        price_cents_annual: def.price_cents_annual ?? 0,
        interval: def.interval,
        credits_per_cycle: def.credits_per_cycle,
        max_smtp_domains: def.max_smtp_domains,
        max_campaigns: def.max_campaigns,
        trial_days: def.trial_days,
        features: def.features,
        features_extra: def.features_extra ?? [],
        is_active: true,
      });
      console.log(`  ➕  New plan record`);
    } else {
      dbPlan.display_name = def.display_name;
      dbPlan.price_cents = def.price_cents;
      dbPlan.price_cents_annual = def.price_cents_annual ?? 0;
      dbPlan.credits_per_cycle = def.credits_per_cycle;
      dbPlan.max_smtp_domains = def.max_smtp_domains;
      dbPlan.max_campaigns = def.max_campaigns;
      dbPlan.features = def.features;
      dbPlan.features_extra = def.features_extra ?? [];
      dbPlan.is_active = true;
      console.log(`  ♻️   Existing plan record – updating`);
    }

    // Free trial: no Stripe product/price
    if (def.name === "free_trial") {
      await dbPlan.save();
      console.log(`  ✅  Saved (no Stripe needed for free trial)`);
      continue;
    }

    // Stripe Product
    const product = await ensureStripeProduct(def, dbPlan.stripe_product_id);
    dbPlan.stripe_product_id = product.id;
    console.log(`  🏷️   Stripe Product: ${product.id}`);

    // Monthly Price – create if missing or wrong currency
    const monthlyMismatch = await priceCurrencyMismatch(dbPlan.stripe_price_id);
    if (!dbPlan.stripe_price_id || monthlyMismatch) {
      if (monthlyMismatch) console.log(`  ⚠️   Monthly price currency mismatch – recreating in ${CURRENCY.toUpperCase()}`);
      const p = await createStripePrice(product.id, def.price_cents, "month", def.name);
      dbPlan.stripe_price_id = p.id;
      console.log(`  💵  Monthly Price created: ${p.id}  ($${(def.price_cents / 100).toFixed(2)}/mo)`);
    } else {
      console.log(`  💵  Monthly Price exists:  ${dbPlan.stripe_price_id}`);
    }

    // Annual Price – create if missing or wrong currency
    if (def.price_cents_annual > 0) {
      const annualMismatch = await priceCurrencyMismatch(dbPlan.stripe_price_id_annual);
      if (!dbPlan.stripe_price_id_annual || annualMismatch) {
        if (annualMismatch) console.log(`  ⚠️   Annual price currency mismatch – recreating in ${CURRENCY.toUpperCase()}`);
        const p = await createStripePrice(product.id, def.price_cents_annual, "year", def.name);
        dbPlan.stripe_price_id_annual = p.id;
        console.log(`  📅  Annual Price created:  ${p.id}  ($${(def.price_cents_annual / 100).toFixed(2)}/yr)`);
      } else {
        console.log(`  📅  Annual Price exists:   ${dbPlan.stripe_price_id_annual}`);
      }
    }

    await dbPlan.save();
    console.log(`  ✅  Saved`);
  }

  console.log(`\n${"═".repeat(52)}`);
  console.log(`🎉  Seeding complete – ${PLAN_DEFINITIONS.length} plans processed.`);
  console.log(`\n📝  Next steps:`);
  console.log(`  1. Verify with: db.plans.find({}, {name:1, stripe_price_id:1, stripe_price_id_annual:1})`);
  console.log(`  2. Configure STRIPE_WEBHOOK_SECRET in .env`);
  console.log(`  3. Test checkout with Stripe test cards`);
  console.log(`${"═".repeat(52)}\n`);
}

seedPlans()
  .catch((err) => { console.error("❌  Seed failed:", err); process.exit(1); })
  .finally(() => mongoose.disconnect());
