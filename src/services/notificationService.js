import mongoose from "mongoose";
import Notification from "../models/notifications.model.js";
import UserNotification from "../models/user_notification.model.js";
import { emitEvent } from "../websockets/emitter.js";
import { getIO } from "../websockets/index.js";
import { userService } from "./userService.js";
import createError from "http-errors";

const toObjectId = (id) => {
  if (!id) return null;
  return mongoose.Types.ObjectId.isValid(id)
    ? new mongoose.Types.ObjectId(id)
    : null;
};

export async function getNotificationsById(options = {}) {
  try {
    const { limit = 10, offset = 0, userId, type } = options;

    const filter = {};
    if (type) filter.type = type;
    if (userId) filter.user_id = toObjectId(userId) || userId;

    const [totalCount, rows] = await Promise.all([
      Notification.countDocuments(filter),
      Notification.find(filter)
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .select("_id title message type createdAt"),
    ]);

    return {
      code: 200,
      data: { rows, totalCount },
      success: true,
      message: "fetched-successfully",
    };
  } catch (error) {
    console.error("Error in getNotifications service:", error);
    throw new Error(`Failed to fetch notifications: ${error.message || error}`);
  }
}

export async function getUserNotificationsById(options = {}) {
  try {
    const { limit = 10, offset = 0, userId, type } = options;

    if (!userId) createError(400, "user-id-required");

    const uid = toObjectId(userId) || userId;

    const match = { user_id: uid };
    const notifMatch = {};
    if (type) notifMatch.type = type;

    const pipeline = [
      { $match: match },
      {
        $lookup: {
          from: "notifications",
          localField: "notification_id",
          foreignField: "_id",
          as: "notificationInfo",
        },
      },
      { $unwind: "$notificationInfo" },
      ...(type ? [{ $match: { "notificationInfo.type": type } }] : []),
      { $sort: { createdAt: -1 } },
      {
        $facet: {
          data: [
            { $skip: offset },
            { $limit: limit },
            {
              $project: {
                _id: 0,
                id: "$notificationInfo._id",
                title: "$notificationInfo.title",
                message: "$notificationInfo.message",
                type: "$notificationInfo.type",
                is_read: "$is_read",
                created_at: "$notificationInfo.createdAt",
              },
            },
          ],
          totalCount: [{ $count: "count" }],
        },
      },
    ];

    const result = await UserNotification.aggregate(pipeline);
    console.log(result);
    
    const data = result?.[0]?.data || [];
    const totalCount = result?.[0]?.totalCount?.[0]?.count || 0;

    return {
      code: 200,
      success: true,
      message: "fetched-successfully",
      data: {
        totalCount,
        data,
      },
    };
  } catch (error) {
    console.error("Error in getUserNotificationsById:", error);
    throw new Error(`Failed to fetch notifications: ${error.message}`);
  }
}

export async function createNotification(notificationDetail) {
  if (!notificationDetail?.user_id) createError(400, "user-id-required");
  if (!notificationDetail?.title) createError(400, "title-required");
  if (!notificationDetail?.type) createError(400, "type-required");

  try {
    const notification = await Notification.create(notificationDetail);
    if (!notification) createError(400, "notification-not-created");
    const io = getIO();

    const payload = {
      id: notification._id,
      title: notification.title,
      type: notification.type,
      message: notification.message,
    };

    if (["system", "promo"].includes(notification.type)) {
      await sendBroadcastNotification(io, payload);
    } else if (["info", "alert", "reminder"].includes(notification.type)) {
      await sendUserNotification(io, notificationDetail?.user_id, payload);
    }

    return {
      code: 201,
      message: "created-successfully",
      data: notification,
      success: true,
    };
  } catch (error) {
    console.error("Error in createNotification service:", error);
    throw new Error(`Failed to create notification: ${error.message}`);
  }
}

export async function sendUserNotification(io, userId, notification) {
  const uid = toObjectId(userId) || userId;
  const roomUserId = String(userId);

  const userNotif = await UserNotification.create({
    user_id: uid,
    notification_id: toObjectId(notification?.id) || notification?.id,
    is_read: false,
    viewed_at: null,
  });

  emitEvent(io, `user:${roomUserId}`, {
    title: notification.title,
    type: notification.type,
    message: notification.message,
    is_read: userNotif.is_read,
  });

  return userNotif;
}

export async function sendBroadcastNotification(io, notification) {
  emitEvent(io, "broadcast", notification);

  const allUserIds = await userService.getAllUserIds();
  const notifId = toObjectId(notification.id) || notification.id;
  
  const batchSize = 1000;   
  for (let i = 0; i < allUserIds.data.length; i += batchSize) {
    const batch = allUserIds.data.slice(i, i + batchSize);

    const docs = batch.map((uid) => ({
      user_id: toObjectId(uid) || uid,
      notification_id: notifId,
      is_read: false,
      viewed_at: null,
    }));

    await UserNotification.insertMany(docs, { ordered: false });
  }

  return notification;
}

export async function bulkCreateNotifications(notificationDetails = []) {
  try {
    if (
      !Array.isArray(notificationDetails) ||
      notificationDetails.length === 0
    ) {
      return { message: "No notifications provided", data: [], success: true };
    }

    const docs = await Notification.insertMany(notificationDetails, {
      ordered: false,
    });

    return {
      message: "created-successfully",
      data: docs,
      success: true,
    };
  } catch (error) {
    console.error("Error in bulkCreateNotifications service:", error);
    throw new Error(`Failed to create notification: ${error.message || error}`);
  }
}

export async function bulkDeleteNotifications(notificationIds = [], userId) {
  try {
    if (!userId) throw new Error("userId is required");
    if (!Array.isArray(notificationIds) || notificationIds.length === 0)
      throw new Error("No notification IDs provided");

    const uid = toObjectId(userId) || userId;
    const ids = notificationIds.map((x) => toObjectId(x) || x).filter(Boolean);

    const res = await UserNotification.deleteMany({
      user_id: uid,
      notification_id: { $in: ids },
    });

    if (!res?.deletedCount) {
      createError(400, "failed-to-delete-notifications");
    }

    return {
      code: 200,
      success: true,
      message: "deleted-successfully",
      data: { deletedCount: res.deletedCount },
    };
  } catch (error) {
    console.error("Error in bulkDeleteNotifications:", error);
    throw new Error(`Failed to delete notifications: ${error.message}`);
  }
}

export async function deleteAllNotifications(userId) {
  const uid = toObjectId(userId) || userId;

  const res = await UserNotification.deleteMany({ user_id: uid });

  if (!res?.deletedCount) createError(400, "failed-to-delete-notifications");

  return {
    message: "deleted-successfully",
    success: true,
    code: 200,
  };
}

const deleteNotificationById = async (userNotificationId) => {
  try {
    const id = toObjectId(userNotificationId) || userNotificationId;

    const notification = await UserNotification.findById(id);
    if (!notification) createError(400, "notification-not-found");

    await UserNotification.deleteOne({ _id: id });

    return {
      code: 200,
      message: "deleted-successfully",
      data: notification,
      success: true,
    };
  } catch (error) {
    console.error("Error in deleteNotification service:", error);
    throw new Error(`Failed to delete notification: ${error.message || error}`);
  }
};

const markAsReadNotification = async (userNotificationId) => {
  try {
    const id = toObjectId(userNotificationId) || userNotificationId;

    const updated = await UserNotification.findByIdAndUpdate(
      id,
      { $set: { is_read: true, viewed_at: new Date()} },
      { new: true },
    );

    if (!updated) createError("notification-not-found");

    return {
      code: 200,
      message: "updated-successfully",
      data: updated,
      success: true,
    };
  } catch (error) {
    console.error("Error in markAsReadNotification service:", error);
    throw new Error(`Failed to update notification: ${error.message || error}`);
  }
};

const markAllAsReadNotification = async (userId) => {
  try {
    const uid = toObjectId(userId) || userId;

    const res = await UserNotification.updateMany(
      { user_id: uid, is_read: false },
      { $set: { is_read: true, viewed_at: new Date() } },
    );

    return {
      code: 200,
      message: "updated-successfully",
      data: res,
      success: true,
    };
  } catch (error) {
    console.error("Error in markAllAsReadNotification service:", error);
    throw new Error(`Failed to update notification: ${error.message || error}`);
  }
};

export const notificationService = {
  bulkCreateNotifications,
  bulkDeleteNotifications,
  createNotification,
  getUserNotificationsById,
  deleteAllNotifications,
  getNotificationsById,
  deleteNotificationById,
  markAsReadNotification,
  markAllAsReadNotification,
};
