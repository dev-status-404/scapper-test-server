import mongoose from "mongoose";

const NotificationsSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      trim: true,
    },
    message: {
      type: String,
      trim: true,
    },
    type: {
      type: String,
      trim: true,
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
NotificationsSchema.index({
  user_id: "text",
});

const Notification = mongoose.model("Notifications", NotificationsSchema);

export default Notification;
