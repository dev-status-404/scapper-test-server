import Bug from "../models/bug.model.js"
import User from "../models/user.model.js";
import Notification from "../models/notifications.model.js";
import { sendUserNotification } from "./notificationService.js";
import { getIO } from "../websockets/index.js";

const notifyAdminsForBug = async (bug, payload) => {
    try {
        const admins = await User.find({ role: "ADMIN", is_deleted: false })
            .select("_id")
            .lean();

        if (!admins.length) {
            return;
        }

        const message = `A new bug has been reported${payload?.user_id ? ` by user ${payload.user_id}` : ""}.`;
        const io = getIO();

        await Promise.all(
            admins.map(async (admin) => {
                const notification = await Notification.create({
                    title: "New bug reported",
                    type: "alert",
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
        console.error("Failed to notify admins for bug creation:", notificationError);
    }
};

const createBug = async (payload) => {
    try {
        const bug = await Bug.create(payload)

        await notifyAdminsForBug(bug, payload);

        return {
            code: 201,
            success: true,
            message: 'Bug created successfully',
            data: bug,
        }
    } catch (error) {
        throw error
    }
}

const getBug = async (filters = {}) => {
    try {
        const { user_id, page = 1, limit = 10 } = filters;
        const query = { is_deleted: false };

        if (user_id) {
            query.user_id = user_id;
        }

        const skip = (page - 1) * limit;

        const [bugs, total] = await Promise.all([
            Bug.find(query)
                .populate({
                    path: 'user_id',
                    select: 'first_name last_name email'
                })
                .skip(skip)
                .limit(parseInt(limit))
                .lean(),
            Bug.countDocuments(query)
        ]);

        return {
            code: 200,
            success: true,
            message: 'Bug retrieved successfully',
            data: bugs,
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(total / limit)
            }
        };
    } catch (error) {
        throw error;
    }
}


const updateBug = async (payload) => {
    try {
        if (!payload.bug_id) {
            return {
                code: 400,
                success: false,
                message: 'Bug ID is required',
            }
        }
        const bug = await Bug.findOneAndUpdate({ _id: payload.bug_id, is_deleted: false }, { bug: payload.bug, status: payload.status }, { new: true })
        return {
            code: 201,
            success: true,
            message: 'Bug updated successfully',
            data: bug,
        }
    } catch (error) {
        throw error
    }
}

const deleteBug = async (filters = {}) => {
    try {
        const { bug_id } = filters;
        if (!bug_id) {
            return {
                code: 400,
                success: false,
                message: 'Bug ID is required',
            }
        }
        const bug = await Bug.findOneAndUpdate({ _id: bug_id }, { is_deleted: true })

        return {
            code: 200,
            success: true,
            message: 'Bug deleted successfully',
            data: bug,
        }
    } catch (error) {
        throw error
    }
}

export const bugService = {
    createBug,
    getBug,
    updateBug,
    deleteBug,
}