import mongoose from "mongoose";

const instagramRelationshipRawSchema = new mongoose.Schema(
  {
    job_id: {
      type: String,
      required: true,
      index: true,
    },
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    target_username: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    relationship_type: {
      type: String,
      enum: ["follower", "following"],
      required: true,
      index: true,
    },
    username: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    instagram_profile_id: {
      type: String,
      default: null,
      trim: true,
    },
    full_name: {
      type: String,
      default: null,
      trim: true,
    },
    is_private: {
      type: Boolean,
      default: null,
    },
    is_verified: {
      type: Boolean,
      default: null,
    },
    avatar_url: {
      type: String,
      default: null,
      trim: true,
    },
    cursor_page: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    source_provider: {
      type: String,
      required: true,
      index: true,
    },
    collected_at: {
      type: Date,
      default: Date.now,
      index: true,
    },
    raw_payload: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  },
);

instagramRelationshipRawSchema.index(
  { job_id: 1, relationship_type: 1, username: 1 },
  { unique: true },
);
instagramRelationshipRawSchema.index({
  user_id: 1,
  target_username: 1,
  relationship_type: 1,
  username: 1,
});
instagramRelationshipRawSchema.index({ username: 1 });
instagramRelationshipRawSchema.index({ collected_at: -1 });

export default mongoose.models.InstagramRelationshipRaw ||
  mongoose.model("InstagramRelationshipRaw", instagramRelationshipRawSchema);
