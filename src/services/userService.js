import createError from "http-errors";
import User from "../models/user.model.js";
import { uploadFileToS3 } from "./awsService.js";
import leadModel from "../models/lead.model.js";
import UserNotification from "../models/user_notification.model.js";
import folderModel from "../models/folder.model.js";
import mongoose from "mongoose";

const updateUser = async (data, file) => {
  try {
    if (file) {
      const uploadedAvatar = await uploadFileToS3(file);
      console.log("uploadedAvatar ======>", uploadedAvatar);
      data.avatar_url = uploadedAvatar;
    }
    const user = await User.findOneAndUpdate({ _id: data._id }, data, {
      new: true,
    });

    if (!user) {
      throw createError(404, "user-not-found");
    }

    return {
      code: 200,
      success: true,
      message: "user-updated",
      data: user,
    };
  } catch (error) {
    console.error("Update User Error:", error);
    throw error;
  }
};

const uploadAvatar = async (userId, file) => {
  try {
    const uploadedAvatar = await uploadFileToS3(file);

    const user = await User.findOneAndUpdate(
      { _id: userId },
      { avatar_url: uploadedAvatar },
      {
        new: true,
      },
    );

    if (!user) {
      throw createError(404, "user-not-found");
    }

    return {
      code: 200,
      success: true,
      message: "user-updated",
      data: user,
    };
  } catch (error) {
    console.error("Upload Avatar Error:", error);
    throw error;
  }
};

const getUsers = async (options = {}) => {
  try {
    const {
      limit = 10,
      offset = 0,
      search, // name/email search
      role,
      is_blocked,
      is_verified,
      auth_provider,
      _id,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = options;

    const q = { is_deleted: false };

    if (_id) q._id = _id;

    if (role) q.role = role;

    if (is_blocked) {
      q.is_blocked = is_blocked;
    }

    if (auth_provider) {
      q.auth_provider = auth_provider;
    }

    if (is_verified) {
      q.is_verified = is_verified;
    }

    if (search) {
      q.$or = [
        { first_name: { $regex: search, $options: "i" } },
        { last_name: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
      ];
    }

    const safeLimit = Math.min(parseInt(limit, 10) || 10, 100);
    const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);
    const order = String(sortOrder).toLowerCase() === "asc" ? 1 : -1;

    const [totalCount, users] = await Promise.all([
      User.countDocuments(q),
      User.find(q)
        .sort({ [sortBy]: order })
        .skip(safeOffset)
        .limit(safeLimit)
        .select(
          "_id first_name last_name email role avatar_url is_blocked is_verified createdAt",
        ),
    ]);

    return {
      code: 200,
      success: true,
      message: "users-fetched",
      data: users,
      pagination: {
        totalCount,
        limit: safeLimit,
        offset: safeOffset,
      },
    };
  } catch (error) {
    console.error("Get Users Error:", error);
    throw error;
  }
};

const getUserById = async (id) => {
  try {
    if (!id) throw createError(400, "user-id-required");

    const user = await User.findById(id).select(
      "_id first_name last_name email role avatar_url blocked verified createdAt updatedAt",
    );

    if (!user) throw createError(404, "user-not-found");

    return {
      code: 200,
      success: true,
      message: "user-fetched",
      data: user,
    };
  } catch (error) {
    console.error("Get User By Id Error:", error);
    throw error;
  }
};

const getAllUserIds = async () => {
  try {
    const users = await User.find({}).select("_id").lean();

    const ids = users.map((u) => String(u._id));

    return {
      code: 200,
      success: true,
      message: "user-ids-fetched",
      data: ids,
    };
  } catch (error) {
    console.error("Get All User Ids Error:", error);
    throw error;
  }
};

export const bulkDeleteUsers = async (userIds = [], actorUserId) => {
  try {
    /* ================= VALIDATION ================= */

    if (!actorUserId) {
      throw createError(400, "actor-user-id-required");
    }

    if (!Array.isArray(userIds) || userIds.length === 0) {
      throw createError(400, "no-user-ids-provided");
    }

    const actorId = mongoose.Types.ObjectId.isValid(actorUserId)
      ? new mongoose.Types.ObjectId(actorUserId)
      : actorUserId;
    if (!actorId) {
      throw createError(400, "invalid-actor-user-id");
    }

    /* ================= ACTOR CHECK ================= */

    const actor = await User.findById(actorId).lean();
    if (!actor) {
      throw createError(404, "actor-user-not-found");
    }

    if (actor.role !== "ADMIN") {
      throw createError(403, "only-admin-can-delete-users");
    }

    /* ================= TARGET USERS ================= */

    const targetIds = userIds
      .map((id) =>
        mongoose.Types.ObjectId.isValid(id)
          ? new mongoose.Types.ObjectId(id)
          : id,
      )
      .filter(Boolean);

    if (targetIds.length === 0) {
      throw createError(400, "invalid-user-ids");
    }

    const targets = await User.find({
      _id: { $in: targetIds },
      is_deleted: { $ne: true },
    }).lean();

    if (!targets.length) {
      throw createError(404, "no-valid-users-found");
    }

    const adminTargets = targets.filter((u) => u.role === "ADMIN");
    if (adminTargets.length > 0) {
      throw createError(400, "cannot-delete-admin-users");
    }

    /* ================= SOFT DELETE ================= */

    const res = await User.updateMany(
      { _id: { $in: targets.map((u) => u._id) } },
      {
        $set: {
          is_deleted: true,
          deleted_at: new Date(),
          deleted_by: actorId,
        },
      },
    );

    if (!res.modifiedCount) {
      throw createError(400, "failed-to-delete-users");
    }

    /* ================= RESPONSE ================= */

    return {
      code: 200,
      success: true,
      message: "users-deleted-successfully",
      data: {
        requested: userIds.length,
        deletedCount: res.modifiedCount,
      },
    };
  } catch (error) {
    console.error("Error in bulkDeleteUsers:", error);
    throw error;
  }
};

export const deleteAccount = async (id) => {
  try {
    if (!id) throw createError(400, "user-id-required");

    const userId = mongoose.Types.ObjectId.isValid(id)
      ? new mongoose.Types.ObjectId(id)
      : id;

    // 1) find user first
    const user = await User.findById(userId);
    if (!user) throw createError(404, "user-not-found");

    // already deleted?
    if (user.is_deleted) {
      return {
        code: 200,
        success: true,
        message: "user-already-deleted",
        data: null,
      };
    }

    // 2) soft delete user
    await User.updateOne(
      { _id: userId },
      {
        $set: {
          is_deleted: true,
          blocked: true, // optional if you want to block access immediately
        },
      },
    );

    // 3) remove from others' contacts
    await User.updateMany(
      { contacts: userId },
      { $pull: { contacts: userId } },
    );

    leadModel.deleteMany({ user_id: userId });
    folderModel.deleteMany({ user_id: userId });
    UserNotification.deleteMany({ user_id: userId });

    // 5) return minimal data
    const updatedUser = await User.findById(userId).select(
      "_id email role is_deleted deletedAt",
    );

    return {
      code: 200,
      success: true,
      message: "user-soft-deleted",
      data: updatedUser,
    };
  } catch (error) {
    console.error("Delete Account Error:", error);
    throw error;
  }
};

export const blockAccount = async (id) => {
  try {
    if (!id) throw createError(400, "user-id-required");

    const userId = mongoose.Types.ObjectId.isValid(id)
      ? new mongoose.Types.ObjectId(id)
      : id;

    // 1) find user first
    const user = await User.findById(userId);
    if (!user) throw createError(404, "user-not-found");

    // 2) soft delete user
    await User.updateOne(
      { _id: userId },
      {
        $set: {
          is_blocked: user.is_blocked? false : true,
        },
      },
    );

    // 3) remove from others' contacts
    await User.updateMany(
      { contacts: userId },
      { $pull: { contacts: userId } },
    );

    // 5) return minimal data
    const updatedUser = await User.findById(userId).select(
      "_id email role is_blocked",
    );

    return {
      code: 200,
      success: true,
      message: "user-blocked",
      data: updatedUser,
    };
  } catch (error) {
    console.error("Delete Account Error:", error);
    throw error;
  }
};

const updateOnboarding = async (userId, step, data) => {
  try {
    let updateData = {};

    if (step === 1) {
      if (!data.heard_about) {
        throw createError(400, "heard_about is required for step 1");
      }
      updateData.heard_about = data.heard_about;
    } else if (step === 2) {
      // Step 2 is optional - users can skip business details
      updateData.business_name = data.business_name || null;
      updateData.business_website = data.business_website || null;
      updateData.business_website_url = data.business_website || null;
      updateData.is_onboarding_completed = true;
    } else {
      throw createError(400, "Invalid step");
    }

    const user = await User.findOneAndUpdate({ _id: userId }, updateData, {
      new: true,
    });

    if (!user) {
      throw createError(404, "user-not-found");
    }

    return {
      code: 200,
      success: true,
      message: "onboarding-updated",
      data: user,
    };
  } catch (error) {
    console.error("Update Onboarding Error:", error);
    throw error;
  }
};

export const userService = {
  updateUser,
  uploadAvatar,
  getUsers,
  getUserById,
  getAllUserIds,
  deleteAccount,
  bulkDeleteUsers,
  blockAccount,
  updateOnboarding,
};
