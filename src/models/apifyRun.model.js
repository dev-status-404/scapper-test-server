import mongoose from "mongoose";

const apifyRunSchema = new mongoose.Schema(
  {
    job_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ScrapeJob",
      default: null,
      index: true,
    },
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    provider: {
      type: String,
      required: true,
      index: true,
    },
    actor_id: {
      type: String,
      required: true,
      index: true,
    },
    run_id: {
      type: String,
      default: null,
    },
    dataset_id: {
      type: String,
      default: null,
      index: true,
    },
    input_count: {
      type: Number,
      default: 0,
      min: 0,
    },
    output_count: {
      type: Number,
      default: 0,
      min: 0,
    },
    status: {
      type: String,
      enum: ["CREATED", "RUNNING", "SUCCEEDED", "FAILED", "TIMED_OUT", "ABORTED", "PARTIAL"],
      default: "CREATED",
      index: true,
    },
    chunk_index: {
      type: Number,
      default: 0,
      min: 0,
    },
    chunk_size: {
      type: Number,
      default: 0,
      min: 0,
    },
    estimated_cost: {
      type: Number,
      default: 0,
      min: 0,
    },
    max_cost_usd: {
      type: Number,
      default: 0,
      min: 0,
    },
    started_at: {
      type: Date,
      default: null,
    },
    finished_at: {
      type: Date,
      default: null,
    },
    last_checked_at: {
      type: Date,
      default: null,
      index: true,
    },
    error_type: {
      type: String,
      default: null,
    },
    error_message: {
      type: String,
      default: null,
    },
    retry_count: {
      type: Number,
      default: 0,
      min: 0,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    processed_at: {
      type: Date,
      default: null,
      index: true,
    },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  },
);

apifyRunSchema.index(
  { job_id: 1, chunk_index: 1 },
  {
    unique: true,
    partialFilterExpression: { job_id: { $type: "objectId" } },
  },
);
apifyRunSchema.index({ run_id: 1 }, { unique: true, sparse: true });
apifyRunSchema.index({ status: 1, last_checked_at: 1 });
apifyRunSchema.index({ user_id: 1, created_at: -1 });

export default mongoose.models.ApifyRun || mongoose.model("ApifyRun", apifyRunSchema);
