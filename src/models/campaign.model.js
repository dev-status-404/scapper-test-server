import mongoose from "mongoose";

const CampaignSchema = new mongoose.Schema(
  {
    // Campaign Basic Information
    name: {
      type: String,
      required: true,
      trim: true,
    },
    subject: {
      type: String,
      required: true,
      trim: true,
    },
    content: {
      type: String,
      required: true,
      trim: true,
    },
    tracking_id: {
      type: String,
      trim: true,
    },

    // Campaign Status and Scheduling
    status: {
      type: String,
      enum: ["DRAFT", "SCHEDULED", "SENDING", "SENT", "PAUSED", "CANCELLED"],
      default: "DRAFT",
      index: true,
    },
    scheduled_at: {
      type: Date,
    },
    sent_at: {
      type: Date,
    },
    campaign_type: {
      type: String,
      enum: ["SPECIFIC", "FOLDER"],
      default: "FOLDER",
    },
    // Targeting
    target_leads: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Lead",
      },
    ],
    target_folders: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Folder",
      },
    ],
    total_recipients: {
      type: Number,
      default: 0,
    },

    // Campaign Owner
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // Email Template (optional – if set, overrides inline content/subject)
    template_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmailTemplate",
      default: null,
    },

    // SMTP account used for sending
    smtp_account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "UserSmtpAccount",
      default: null,
    },

    // Email Configuration
    from_email: {
      type: String,
      required: true,
      trim: true,
    },
    from_name: {
      type: String,
      trim: true,
    },
    reply_to: {
      type: String,
      trim: true,
    },

    // Tracking Configuration
    track_opens: {
      type: Boolean,
      default: true,
    },
    track_clicks: {
      type: Boolean,
      default: true,
    },

    // Analytics (Real-time updates)
    analytics: {
      sent: {
        type: Number,
        default: 0,
      },
      delivered: {
        type: Number,
        default: 0,
      },
      opened: {
        type: Number,
        default: 0,
      },
      unique_opens: {
        type: Number,
        default: 0,
      },
      clicked: {
        type: Number,
        default: 0,
      },
      unique_clicks: {
        type: Number,
        default: 0,
      },
      failed: {
        type: Number,
        default: 0,
      },
      bounced: {
        type: Number,
        default: 0,
      },
    },

    // Soft delete
    is_deleted: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true, // createdAt & updatedAt
  },
);

// Indexes for performance optimization
CampaignSchema.index({ user_id: 1, status: 1 });
CampaignSchema.index({ scheduled_at: 1 });
CampaignSchema.index({ sent_at: 1 });
CampaignSchema.index({ name: "text", subject: "text" });

// Virtual for calculating open rate
CampaignSchema.virtual("open_rate").get(function () {
  const total =
    this.total_recipients || this.analytics.delivered || this.analytics.sent;
  return total > 0 ? ((this.analytics.unique_opens || 0) / total) * 100 : 0;
});

// Virtual for calculating click rate
CampaignSchema.virtual("click_rate").get(function () {
  const total =
    this.total_recipients || this.analytics.delivered || this.analytics.sent;
  return total > 0 ? ((this.analytics.unique_clicks || 0) / total) * 100 : 0;
});

// Virtual for calculating bounce rate
CampaignSchema.virtual("bounce_rate").get(function () {
  const delivered = this.analytics.delivered || this.analytics.sent || 0;
  const bounced = this.analytics.bounced || this.analytics.failed || 0;
  const total = delivered + bounced;
  return total > 0 ? (bounced / total) * 100 : 0;
});

// Virtual for calculating delivery rate
CampaignSchema.virtual("delivery_rate").get(function () {
  const delivered = this.analytics.delivered || this.analytics.sent || 0;
  const bounced = this.analytics.bounced || this.analytics.failed || 0;
  const total = delivered + bounced;
  return total > 0 ? (delivered / total) * 100 : 0;
});

// ✅ allow virtuals in JSON + lean
CampaignSchema.set("toJSON", { virtuals: true });
CampaignSchema.set("toObject", { virtuals: true });

export default mongoose.model("Campaign", CampaignSchema);
