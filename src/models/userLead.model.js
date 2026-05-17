import mongoose from "mongoose";

/**
 * UserLead — Junction table between User ↔ Lead
 *
 * Every time a user scrapes a profile (Instagram / LinkedIn / Manual) or
 * manually links an existing lead, a UserLead record is created.
 * This lets the same global Lead document be shared across users without
 * duplicating scraped data, while each user has their own folder/relationship
 * context over that lead.
 *
 * Deduplication contract:
 *   - One record per (user_id + lead_id) pair.
 *   - The unique compound index enforces this at the DB level.
 */
const UserLeadSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    lead_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lead",
      required: true,
      index: true,
    },
    folder_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Folder",
      default: null,
      index: true,
    },
    /**
     * INSTAGRAM | LINKEDIN | MANUAL
     * Mirrors lead.type but stored here so the join layer knows the origin.
     */
    type: {
      type: String,
      enum: ["INSTAGRAM", "LINKEDIN", "MANUAL"],
      default: "MANUAL",
      index: true,
    },
    /**
     * For Instagram followers/following scrapes: the target account username
     * that was scraped (e.g. "nike" when we scraped @nike's followers).
     */
    scraped_from_username: {
      type: String,
      trim: true,
      default: null,
      index: true,
    },
    /**
     * "follower"  → the lead follows scraped_from_username
     * "following" → scraped_from_username follows the lead
     * null        → profile-level or LinkedIn scrape (no directional relationship)
     */
    relationship_type: {
      type: String,
      enum: ["follower", "following", null],
      default: null,
      index: true,
    },
    /**
     * True when this UserLead was created from cached/existing lead data
     * (i.e. the lead already existed in the DB when the user scraped).
     */
    is_cached: {
      type: Boolean,
      default: false,
    },
    /**
     * Soft-delete flag. The UserLead is marked deleted when the user removes
     * the lead from their view, without touching the underlying Lead document.
     */
    is_deleted: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

// ── Uniqueness: one UserLead per user+lead pair ──────────────────────────────
UserLeadSchema.index({ user_id: 1, lead_id: 1 }, { unique: true });

// ── Fast lookup: all leads for a user (with optional folder filter) ──────────
UserLeadSchema.index({ user_id: 1, is_deleted: 1, createdAt: -1 });
UserLeadSchema.index({ user_id: 1, folder_id: 1, is_deleted: 1 });
UserLeadSchema.index({ user_id: 1, type: 1, is_deleted: 1 });
UserLeadSchema.index({
  user_id: 1,
  scraped_from_username: 1,
  relationship_type: 1,
  is_deleted: 1,
});

const UserLead = mongoose.model("UserLead", UserLeadSchema);

export default UserLead;
