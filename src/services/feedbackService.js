import Feedback from "../models/feedback.model.js";
import User from "../models/user.model.js";
import Notification from "../models/notifications.model.js";
import { sendUserNotification } from "./notificationService.js";
import { getIO } from "../websockets/index.js";

const notifyAdminsForFeedback = async (payload) => {
  try {
    const admins = await User.find({ role: "ADMIN", is_deleted: false })
      .select("_id")
      .lean();

    if (!admins.length) {
      return;
    }

    const message = `A new feedback has been submitted${payload?.user_id ? ` by user ${payload.user_id}` : ""}.`;
    const io = getIO();

    await Promise.all(
      admins.map(async (admin) => {
        const notification = await Notification.create({
          title: "New feedback received",
          type: "info",
          message,
        });

        await sendUserNotification(io, admin._id, {
          id: notification._id,
          title: notification.title,
          type: notification.type,
          message: notification.message,
        });
      }),
    );
  } catch (notificationError) {
    console.error(
      "Failed to notify admins for feedback creation:",
      notificationError,
    );
  }
};

const createFeedback = async (payload) => {
  try {
    const feedback = await Feedback.create(payload);
    await User.updateOne(
      { _id: payload.user_id },
      { is_feedback_completed: true },
    );

    await notifyAdminsForFeedback(payload);

    return {
      code: 201,
      success: true,
      message: "Feedback created successfully",
      data: feedback,
    };
  } catch (error) {
    throw error;
  }
};

const getFeedback = async (filters = {}) => {
  try {
    const { user_id, page = 1, limit = 10 } = filters;
    const query = { is_deleted: false };

    if (user_id) {
      query.user_id = user_id;
    }

    const skip = (page - 1) * limit;

    const [feedbacks, total] = await Promise.all([
      Feedback.find(query)
        .populate({
          path: "user_id",
          select: "first_name last_name email",
        })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Feedback.countDocuments(query),
    ]);

    return {
      code: 200,
      success: true,
      message: "Feedback retrieved successfully",
      data: feedbacks,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / limit),
      },
    };
  } catch (error) {
    throw error;
  }
};

const updateFeedback = async (payload) => {
  try {
    if (!payload.feedback_id) {
      return {
        code: 400,
        success: false,
        message: "Feedback ID is required",
      };
    }
    const feedback = await Feedback.findOneAndUpdate(
      { _id: payload.feedback_id, is_deleted: false },
      { feedback: payload.feedback },
    );
    return {
      code: 201,
      success: true,
      message: "Feedback updated successfully",
      data: feedback,
    };
  } catch (error) {
    throw error;
  }
};

const deleteFeedback = async (filters = {}) => {
  try {
    const { feedback_id } = filters;
    if (!feedback_id) {
      return {
        code: 400,
        success: false,
        message: "Folder ID is required",
      };
    }
    const feedback = await Feedback.findOneAndUpdate(
      { _id: feedback_id },
      { is_deleted: true },
    );

    return {
      code: 200,
      success: true,
      message: "Feedback deleted successfully",
      data: feedback,
    };
  } catch (error) {
    throw error;
  }
};

export const feedbackService = {
  createFeedback,
  getFeedback,
  updateFeedback,
  deleteFeedback,
};
