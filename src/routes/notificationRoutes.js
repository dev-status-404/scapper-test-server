import express from "express";
import {notificationController}  from "../controllers/notificationsController.js";
import auth from "../middlewares/auth.js";

const router = express.Router();

/**
 * USER ROUTES
 * Base: /api/notifications
 */
router.get("/",auth(['ADMIN','USER']), notificationController.getUserNotifications);
router.post("/read-all", notificationController.markAllAsReadNotification);
router.post("/read/:notificationId", notificationController.markAsReadNotification);
router.post("/all", notificationController.deleteAllNotifications);
router.delete("/:notificationId", notificationController.deleteNotificationById);
router.post("/bulk-delete", notificationController.bulkDeleteNotifications);

/**
 * ADMIN / SYSTEM ROUTES
 * (Keep these protected by role middleware if needed)
 */
router.get("/admin/all", notificationController.getAllNotifications);
router.post("/", notificationController.createNotification);
router.post("/bulk", notificationController.bulkCreateNotifications);

export default router;
