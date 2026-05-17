import { safeError } from "../middlewares/error.js";
import { notificationService } from "../services/notificationService.js";
import { parseOffset } from "../utils/parseHelper.js";

const getUserNotifications = async (req, res) => {
  try {
    const limit = parseOffset(req.query.limit);
    const offset = parseOffset(req.query.offset);

    const response = await notificationService.getUserNotificationsById({
      userId: req.user?._id,
      limit,
      offset,
      type: req.query.type,
    });

    const status = response?.code || 200;
    return res.status(status).json(response);
  } catch (error) {
    const err = safeError(error);
    return res.status(err.code).json(err);
  }
};

const getAllNotifications = async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit);
    const offset = parseOffset(req.query.offset);

    const response = await notificationService.getNotificationsById({
      limit,
      offset,
      type: req.query.type,
      userId: req.query.userId,
    });

    const status = response?.code || 200;
    return res.status(status).json(response);
  } catch (error) {
    const err = safeError(error);
    return res.status(err.code).json(err);
  }
};

const createNotification = async (req, res) => {
  try {
    const response = await notificationService.createNotification(req.body);
    const status = response?.code || 201;
    return res.status(status).json(response);
  } catch (error) {
    const err = safeError(error);
    return res.status(err.code).json(err);
  }
};

const bulkCreateNotifications = async (req, res) => {
  try {
    const response = await notificationService.bulkCreateNotifications(
      req.body,
    );
    const status = response?.code || 201;
    return res.status(status).json(response);
  } catch (error) {
    const err = safeError(error);
    return res.status(err.code).json(err);
  }
};

const markAsReadNotification = async (req, res) => {
  try {
    const response = await notificationService.markAsReadNotification(
      req.params.notificationId,
    );

    const status = response?.code || 200;
    return res.status(status).json(response);
  } catch (error) {
    const err = safeError(error);
    return res.status(err.code).json(err);
  }
};

const markAllAsReadNotification = async (req, res) => {
  console.log( req.body._id,);
  
  try {
    const response = await notificationService.markAllAsReadNotification(
      req.body._id,
    );

    const status = response?.code || 200;
    return res.status(status).json(response);
  } catch (error) {
    const err = safeError(error);
    return res.status(err.code).json(err);
  }
};

const deleteNotificationById = async (req, res) => {
  try {
    const response = await notificationService.deleteNotificationById(
      req.params.notificationId,
    );

    const status = response?.code || 200;
    return res.status(status).json(response);
  } catch (error) {
    const err = safeError(error);
    return res.status(err.code).json(err);
  }
};

const deleteAllNotifications = async (req, res) => {
  try {
    const response = await notificationService.deleteAllNotifications(
      req.body?._id,
    );

    const status = response?.code || 200;
    return res.status(status).json(response);
  } catch (error) {
    const err = safeError(error);
    return res.status(err.code).json(err);
  }
};

const bulkDeleteNotifications = async (req, res) => {
  try {
    const response = await notificationService.bulkDeleteNotifications(
      req.body.notificationIds,
      req.user?.id,
    );

    const status = response?.code || 200;
    return res.status(status).json(response);
  } catch (error) {
    const err = safeError(error);
    return res.status(err.code).json(err);
  }
};

export const notificationController = {
  getUserNotifications,
  getAllNotifications,
  createNotification,
  bulkCreateNotifications,
  markAsReadNotification,
  markAllAsReadNotification,
  deleteNotificationById,
  deleteAllNotifications,
  bulkDeleteNotifications,
};
