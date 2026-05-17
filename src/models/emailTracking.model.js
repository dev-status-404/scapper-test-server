import mongoose from "mongoose";

const EmailTrackingSchema = new mongoose.Schema(
  {
    campaign_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Campaign",
      required: true,
      index: true,
    },
    lead_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lead",
      required: true,
      index: true,
    },
    tracking_id: {
      type: String,
      required: true,
      unique: true,
    },
    delivered_at: {
      type: Date,
      default: null,
    },
    opened_at: {
      type: Date,
      default: null,
    },
    last_opened_at: {
      type: Date,
      default: null,
    },
    open_count: {
      type: Number,
      default: 0,
    },
    ignored_open_count: {
      type: Number,
      default: 0,
    },
    last_open_user_agent: {
      type: String,
      default: null,
    },
    last_open_ip: {
      type: String,
      default: null,
    },
    clicked: {
      type: Boolean,
      default: false,
    },
    clicked_at: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for efficient lookups
EmailTrackingSchema.index({ campaign_id: 1, lead_id: 1 });

export default mongoose.model("EmailTracking", EmailTrackingSchema);
