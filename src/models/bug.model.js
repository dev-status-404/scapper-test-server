import mongoose from "mongoose";

const BugSchema = new mongoose.Schema(
  {
    bug: {
      type: String,
      trim: true,
    },
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    status: {
      type: String,
      enum: ["open", "in_progress", "resolved"],
      default: "open",
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
BugSchema.index({
  user_id: "text",
});

BugSchema.virtual("user", {
  ref: "User",
  localField: "user_id",
  foreignField: "_id",
  justOne: true,
});

// ✅ allow virtuals in JSON + lean
BugSchema.set("toJSON", { virtuals: true });
BugSchema.set("toObject", { virtuals: true });

export default mongoose.model("Bug", BugSchema);
