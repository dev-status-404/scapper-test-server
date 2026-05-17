import mongoose from "mongoose";

const scrapeJobSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    folder_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Folder",
      default: null,
      index: true,
    },
    target_username: {
      type: String,
      trim: true,
      index: true,
    },
    scrape_type: {
      type: String,
      enum: ["followers", "following", "profile", "bulk_profiles"],
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ["followers", "following", "profile", "bulk_profiles"],
      default: null,
      index: true,
    },
    requested_limit: { type: Number, default: 0, min: 0 },
    effective_limit: { type: Number, default: 0, min: 0 },
    collected_count: { type: Number, default: 0, min: 0 },
    enriched_count: { type: Number, default: 0, min: 0 },
    deep_scanned_count: { type: Number, default: 0, min: 0 },
    saved_count: { type: Number, default: 0, min: 0 },
    duplicate_count: { type: Number, default: 0, min: 0 },
    failed_count: { type: Number, default: 0, min: 0 },
    refunded_count: { type: Number, default: 0, min: 0 },
    status: {
      type: String,
      enum: [
        "QUEUED",
        "RUNNING",
        "PAUSED",
        "CANCEL_REQUESTED",
        "CANCELLED",
        "SUCCEEDED",
        "PARTIAL",
        "FAILED",
        "TIMED_OUT",
      ],
      default: "QUEUED",
      index: true,
    },
    stage: {
      type: String,
      enum: [
        "VALIDATING",
        "COLLECTING_RELATIONSHIPS",
        "SAVING_RAW_USERS",
        "DEDUPING",
        "ENRICHING_PROFILES",
        "DEEP_SCANNING",
        "SAVING_LEADS",
        "RECONCILING_CREDITS",
        "COMPLETED",
      ],
      default: "VALIDATING",
      index: true,
    },
    cursor: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    provider: {
      type: String,
      default: null,
    },
    apify_run_id: {
      type: String,
      default: null,
      index: true,
    },
    apify_dataset_id: {
      type: String,
      default: null,
      index: true,
    },
    fallback_provider: {
      type: String,
      default: null,
    },
    cost_budget_usd: { type: Number, default: 0, min: 0 },
    cost_limit_usd: { type: Number, default: 0, min: 0 },
    cost_spent_estimate_usd: { type: Number, default: 0, min: 0 },
    estimated_cost_usd: { type: Number, default: 0, min: 0 },
    credits_reserved: { type: Number, default: 0, min: 0 },
    credits_charged: { type: Number, default: 0, min: 0 },
    credits_refunded: { type: Number, default: 0, min: 0 },
    credit_transaction_ids: {
      type: [String],
      default: [],
    },
    pause_requested: { type: Boolean, default: false, index: true },
    cancel_requested: { type: Boolean, default: false, index: true },
    error_type: { type: String, default: null },
    error_message: { type: String, default: null },
    idempotency_key: {
      type: String,
      default: null,
    },
    started_at: { type: Date, default: null },
    finished_at: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  },
);

scrapeJobSchema.index({ user_id: 1, status: 1, created_at: -1 });
scrapeJobSchema.index(
  { user_id: 1, target_username: 1, scrape_type: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ["QUEUED", "RUNNING", "PAUSED", "CANCEL_REQUESTED"] },
    },
  },
);
scrapeJobSchema.index(
  { idempotency_key: 1 },
  {
    unique: true,
    sparse: true,
  },
);
scrapeJobSchema.index({ status: 1, updated_at: 1 });

export default mongoose.models.ScrapeJob || mongoose.model("ScrapeJob", scrapeJobSchema);
