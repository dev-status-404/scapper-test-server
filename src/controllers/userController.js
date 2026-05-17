import { safeError } from "../middlewares/error.js";
import { userService } from "../services/userService.js";
import { t } from "../utils/i18n.js";

const updateUser = async (req, res) => {
  try {
    const data = { ...req.body, _id: req.user._id };
    const response = await userService.updateUser(data, req.file);
    return res.status(response.code).json({
      code: response.code,
      success: response.success,
      message: t(response.message),
      data: response.data,
    });
  } catch (error) {
    return safeError(res, error);
  }
};

const uploadAvatar = async (req, res) => {
  try {
    const response = await userService.uploadAvatar(req.user._id, req.file);
    return res.status(response.code).json({
      code: response.code,
      success: response.success,
      message: t(response.message),
      data: response.data,
    });
  } catch (error) {
    return safeError(res, error);
  }
};

const blockAccount = async (req, res) => {
  try {
    const response = await userService.blockAccount(req.params.userId);
    return res.status(response.code).json({
      code: response.code,
      success: response.success,
      message: t(response.message),
      data: response.data,
    });
  } catch (error) {
    return safeError(res, error);
  }
};

const getUsers = async (req, res) => {
  try {
    const response = await userService.getUsers(req.query);
    return res.status(response.code).json({
      code: response.code,
      success: response.success,
      message: t(response.message),
      data: response.data,
      pagination: response.pagination,
    });
  } catch (error) {
    return safeError(res, error);
  }
};

const getUserById = async (req, res) => {
  try {
    const response = await userService.getUserById(req.params.id);
    return res.status(response.code).json({
      code: response.code,
      success: response.success,
      message: t(response.message),
      data: response.data,
    });
  } catch (error) {
    return safeError(res, error);
  }
};

const deleteAccount = async (req, res) => {
  try {
    const response = await userService.deleteAccount(req.params.userId);
    return res.status(response.code).json({
      code: response.code,
      success: response.success,
      message: t(response.message),
      data: response.data,
    });
  } catch (error) {
    return safeError(res, error);
  }
};

const bulkDeleteUsers = async (req, res) => {
  try {
    const response = await userService.bulkDeleteUsers(
      req.body.userIds,
      req.body.actorId,
    );
    return res.status(response.code).json({
      code: response.code,
      success: response.success,
      message: t(response.message),
      data: response.data,
    });
  } catch (error) {
    return safeError(res, error);
  }
};

const updateOnboarding = async (req, res) => {
  try {
    const { step, ...data } = req.body;
    const response = await userService.updateOnboarding(req.user._id, step, data);
    return res.status(response.code).json({
      code: response.code,
      success: response.success,
      message: t(response.message),
      data: response.data,
    });
  } catch (error) {
    return safeError(res, error);
  }
};

export const userController = {
  updateUser,
  uploadAvatar,
  blockAccount,
  deleteAccount,
  bulkDeleteUsers,
  getUsers,
  getUserById,
  updateOnboarding,
};
