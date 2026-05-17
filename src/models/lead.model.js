import mongoose from "mongoose";

const SCRAPED_LEAD_TYPES = new Set(["INSTAGRAM", "LINKEDIN"]);

const hasValue = (value) =>
  value !== undefined && value !== null && String(value).trim() !== "";

const isScrapedLeadPayload = (payload = {}) => {
  if (!payload) return false;
  const type = hasValue(payload.type) ? String(payload.type).toUpperCase() : "";
  return (
    SCRAPED_LEAD_TYPES.has(type) ||
    hasValue(payload.scrape_id) ||
    hasValue(payload.scraped_from_username)
  );
};

const keepScrapeStatusTrue = (payload) => {
  if (payload && isScrapedLeadPayload(payload)) {
    payload.scrape_status = true;
  }
};

const getUpdateFields = (update = {}) => ({
  ...update,
  ...(update.$set || {}),
  ...(update.$setOnInsert || {}),
});

const LeadSchema = new mongoose.Schema(
  {
    // Basic Information
    first_name: {
      type: String,
      trim: true,
    },
    last_name: {
      type: String,
      trim: true,
    },
    // ✅ Email as array
    emails: [
      {
        type: String,
        lowercase: true,
        trim: true,
      },
    ],
    phone_numbers: [
      {
        type: String,
        lowercase: true,
        trim: true,
      },
    ],
    sms_number: {
      type: String,
      trim: true,
    },
    whatsapp_number: {
      type: String,
      trim: true,
    },
    landline_number: {
      type: String,
      trim: true,
    },
    company: {
      type: String,
      trim: true,
    },
    job_title: {
      type: String,
      trim: true,
    },
    location: {
      type: String,
      trim: true,
    },
    gender: {
      type: String,
      trim: true,
    },
    experience_years: {
      type: Number,
      default: null,
    },
    industry: {
      type: String,
      trim: true,
    },
    headline: {
      type: String,
      trim: true,
    },
    skills: {
      type: [String],
      default: [],
    },
    summary: {
      type: String,
      trim: true,
    },
    education: {
      type: [String],
      default: [],
    },
    experiences: {
      type: [
        {
          position: {
            type: String,
            trim: true,
          },
          company: {
            type: String,
            trim: true,
          },
          industry: {
            type: String,
            trim: true,
          },
          started: {
            type: Date,
            default: null,
          },
          ended: {
            type: Date,
            default: null,
          },
          current: {
            type: Boolean,
            default: false,
          },
        },
      ],
      default: [],
    },
    social_profiles: {
      type: [
        {
          type: {
            type: String,
            trim: true,
          },
          link: {
            type: String,
            trim: true,
          },
        },
      ],
      default: [],
    },
    languages: {
      type: [String],
      default: [],
    },
    honors_awards: {
      type: [String],
      default: [],
    },
    request_id: {
      type: String,
      trim: true,
    },
    message: {
      type: String,
      trim: true,
    },
    source_url: {
      type: String,
      trim: true,
    },
    source_rul: {
      type: String,
      trim: true,
    },
    instagram_profile_id: {
      type: String,
      trim: true,
    },
    username: {
      type: String,
      trim: true,
    },
    full_name: {
      type: String,
      trim: true,
    },
    bio: {
      type: String,
      trim: true,
    },
    avatar_url: {
      type: String,
      trim: true,
    },
    avatar_rul: {
      type: String,
      trim: true,
    },
    followers: {
      type: Number,
      default: null,
    },
    following: {
      type: Number,
      default: null,
    },
    follower_count: {
      type: Number,
      default: null,
    },
    following_count: {
      type: Number,
      default: null,
    },
    total_posts: {
      type: Number,
      default: null,
    },
    category: {
      type: String,
      trim: true,
    },
    external_url: {
      type: String,
      trim: true,
    },
    external_url_linkshimmed: {
      type: String,
      trim: true,
    },
    external_urls: {
      type: [String],
      default: [],
    },
    is_private: {
      type: Boolean,
      default: null,
    },
    is_verified: {
      type: Boolean,
      default: null,
    },
    is_public: {
      type: Boolean,
      default: null,
    },
    fb_profile_biolink: {
      url: {
        type: String,
        trim: true,
      },
      name: {
        type: String,
        trim: true,
      },
    },
    highlight_reel_count: {
      type: Number,
      default: null,
    },
    links: {
      type: [
        {
          title: {
            type: String,
            trim: true,
          },
          url: {
            type: String,
            trim: true,
          },
          lynx_url: {
            type: String,
            trim: true,
          },
          link_type: {
            type: String,
            trim: true,
          },
          subtitle: {
            type: String,
            trim: true,
          },
        },
      ],
      default: [],
    },
    // Follower/Following Relationship Tracking
    scraped_from_username: {
      type: String,
      trim: true,
      index: true,
      default: null,
      // Stores the target account username this lead was scraped from
      // Example: If we scraped followers of @nike, this would be "nike"
    },
    relationship_type: {
      type: String,
      enum: ["follower", "following", null],
      default: null,
      index: true,
      // "follower" = this lead follows the scraped_from_username
      // "following" = the scraped_from_username follows this lead
    },
    folder_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Folder",
      index: true,
      default: null,
    },
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    is_converted: {
      type: Boolean,
      default: false,
      index: true,
    },
    converted_at: {
      type: Date,
    },
    type: {
      type: String,
      enum: ["INSTAGRAM", "LINKEDIN", "MANUAL"],
      default: "MANUAL",
      index: true,
    },
    scrape_id: {
      type: String,
      trim: true,
    },
    scrape_status: {
      type: Boolean,
      default: false,
      trim: true,
    },
    deep_scan_status: {
      type: String,
      enum: ["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "SKIPPED", "BLOCKED", null],
      default: null,
      index: true,
    },
    deep_scan_result_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DeepScanResult",
      default: null,
      index: true,
    },
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

// Indexes for search optimization
LeadSchema.index({
  first_name: "text",
  last_name: "text",
  folder: "text",
  user_id: "text",
  email: "text",
  company: "text",
});

// Performance indexes for common queries
LeadSchema.index({ username: 1 }); // Find by Instagram username
LeadSchema.index({ instagram_profile_id: 1 }); // Find by Instagram ID
LeadSchema.index({ user_id: 1, type: 1 }); // Filter by user and source type
LeadSchema.index({ user_id: 1, folder_id: 1 }); // Filter by user and folder
LeadSchema.index({ createdAt: -1 }); // Sort by creation date
LeadSchema.index({ scraped_from_username: 1, relationship_type: 1 }); // Find all followers/following of an account
LeadSchema.index({
  user_id: 1,
  scraped_from_username: 1,
  relationship_type: 1,
}); // Compound index for user-specific queries

LeadSchema.pre("validate", function normalizeScrapedLead(next) {
  keepScrapeStatusTrue(this);
  next();
});

LeadSchema.pre("insertMany", function normalizeScrapedLeadBulk(next, docs) {
  const leadDocs = Array.isArray(docs) ? docs : [docs];
  leadDocs.forEach((doc) => keepScrapeStatusTrue(doc));
  next();
});

const normalizeScrapedLeadUpdate = async function (next) {
  const update = this.getUpdate();
  if (!update || Array.isArray(update)) {
    next();
    return;
  }

  const updateFields = getUpdateFields(update);
  const updateIsScrapedLead = isScrapedLeadPayload(updateFields);
  const updateTurnsOffScrapeStatus =
    updateFields.scrape_status === false ||
    hasValue(update.$unset?.scrape_status);
  const currentLead =
    !updateIsScrapedLead && updateTurnsOffScrapeStatus
      ? await this.model
          .findOne(this.getQuery())
          .select("type scrape_id scraped_from_username")
          .lean()
      : null;

  if (updateIsScrapedLead || isScrapedLeadPayload(currentLead)) {
    update.$set = {
      ...(update.$set || {}),
      scrape_status: true,
    };
    delete update.scrape_status;
    delete update.$unset?.scrape_status;
    if (update.$unset && Object.keys(update.$unset).length === 0) {
      delete update.$unset;
    }
    this.setUpdate(update);
  }

  next();
};

["findOneAndUpdate", "updateOne", "updateMany"].forEach((hook) => {
  LeadSchema.pre(hook, normalizeScrapedLeadUpdate);
});

export default mongoose.model("Lead", LeadSchema);
