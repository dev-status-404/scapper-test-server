import mongoose from "mongoose";

const { Schema } = mongoose;

const UserNotificationSchema = new Schema(
  {
    user_id: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
      required: false,
    },

    notification_id: {
      type: Schema.Types.ObjectId,
      ref: "Notification",
      index: true,
      required: false,
    },

    is_read: {
      type: Boolean,
      default: false,
      index: true,
    },

    viewed_at: {
      type: Date,
      default: null,
    },

    deletion_date: {
      type: Date,
      default: null,
      index: true,
    },
  },
  {
    timestamps: true, // adds createdAt & updatedAt
    collection: "user_notifications",
  },
);

/* ========== INDEXES (IMPORTANT) ========== */

// Fast unread queries per user
UserNotificationSchema.index({ user_id: 1, is_read: 1 });

// Prevent duplicate notifications per user
UserNotificationSchema.index(
  { user_id: 1, notification_id: 1 },
  { unique: true },
);

// Fast cleanup / soft-delete support
UserNotificationSchema.index({ deletion_date: 1 });

const UserNotification = mongoose.model("UserNotification", UserNotificationSchema);
export default UserNotification;