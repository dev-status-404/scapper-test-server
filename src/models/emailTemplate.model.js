import mongoose from "mongoose";

const EmailTemplateSchema = new mongoose.Schema(
  {
    // Template Information
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },

    // Template Content
    subject: {
      type: String,
      required: true,
      trim: true,
    },
    content: {
      type: String,
      required: true,
    },
    preheader: {
      type: String,
      trim: true,
    },

    // Template Variables/Placeholders
    variables: [
      {
        key: {
          type: String,
          required: true,
        },
        description: {
          type: String,
        },
      },
    ],

    // Template Settings
    is_html: {
      type: Boolean,
      default: true,
    },
    category: {
      type: String,
      enum: ["CAMPAIGN", "WELCOME", "PROMOTIONAL", "TRANSACTIONAL", "OTHER"],
      default: "CAMPAIGN",
    },

    // Owner
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // Status
    is_active: {
      type: Boolean,
      default: true,
      index: true,
    },
    is_deleted: {
      type: Boolean,
      default: false,
      index: true,
    },

    // Usage Statistics
    usage_count: {
      type: Number,
      default: 0,
    },
    last_used_at: {
      type: Date,
    },

    // Tags for categorization
    tags: [
      {
        type: String,
        trim: true,
      },
    ],
  },
  {
    timestamps: true,
  },
);

// Indexes for performance
EmailTemplateSchema.index({ user_id: 1, is_active: 1 });
EmailTemplateSchema.index({ category: 1, user_id: 1 });
EmailTemplateSchema.index({ name: "text", description: "text" });
EmailTemplateSchema.index({ tags: 1 });

// Virtual for preview (first 100 chars of content)
EmailTemplateSchema.virtual("preview").get(function () {
  const stripHtml = this.content.replace(/<[^>]*>/g, "");
  return stripHtml.substring(0, 100);
});

EmailTemplateSchema.set("toJSON", { virtuals: true });
EmailTemplateSchema.set("toObject", { virtuals: true });

export default mongoose.model("EmailTemplate", EmailTemplateSchema);
