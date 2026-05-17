import mongoose from "mongoose";

const deepScanResultSchema = new mongoose.Schema(
  {
    normalized_url: { type: String, required: true, unique: true, index: true },
    root_domain: { type: String, required: true, index: true },
    final_url: { type: String, default: null },
    status: {
      type: String,
      enum: ["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "SKIPPED", "BLOCKED"],
      default: "PENDING",
      index: true,
    },
    http_status: { type: Number, default: null },
    emails: { type: [String], default: [] },
    phone_numbers: { type: [String], default: [] },
    contact_page_urls: { type: [String], default: [] },
    html_title: { type: String, default: null },
    error_type: { type: String, default: null },
    error_message: { type: String, default: null },
    scan_attempts: { type: Number, default: 0, min: 0 },
    last_scanned_at: { type: Date, default: null },
    expires_at: { type: Date, default: null, index: true },
    source_lead_ids: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: "Lead",
      default: [],
    },
    source_usernames: { type: [String], default: [] },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  },
);

deepScanResultSchema.index({ root_domain: 1, last_scanned_at: -1 });
deepScanResultSchema.index({ status: 1, updated_at: 1 });

export default mongoose.models.DeepScanResult ||
  mongoose.model("DeepScanResult", deepScanResultSchema);
