import mongoose from "mongoose";

const FeedbackSchema = new mongoose.Schema(
  {
    feedback: {
      type: String,
      trim: true,
    },
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
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
FeedbackSchema.index({
  user_id: "text",
});

FeedbackSchema.virtual("user", {
  ref: "User",
  localField: "user_id",
  foreignField: "_id",
  justOne: true,
});

FeedbackSchema.set("toJSON", { virtuals: true });
FeedbackSchema.set("toObject", { virtuals: true });

export default mongoose.model("Feedback", FeedbackSchema);
