import { authService } from "../services/authService.js";
import { sendError } from "../utils/errorHelper.js";

const register = async (req, res) => {
  try {
    const response = await authService.register(req.body);
    return res.status(response.code).json({
      code: response.code,
      success: response.success,
      message: response.message,
      data: response.data,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

const login = async (req, res) => {
  try {
    console.log("Login Is here ====>", req.body);
    const response = await authService.login(req.body);
    return res.status(response.code).json({
      code: response.code,
      success: response.success,
      message: response.message,
      data: response.data,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

const googleLogin = async (req, res) => {
  try {
    const response = await authService.googleLogin(req.body);
    return res.status(response.code).json({
      code: response.code,
      success: response.success,
      message: response.message,
      data: response.data,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

const verifyOTP = async (req, res) => {
  try {
    const response = await authService.verifyOTP({
      email: req.body.email,
      otp: req.body.otp,
    });
    return res.status(response.code).json({
      code: response.code,
      success: response.success,
      message: response.message,
      data: response.data,
    });
  } catch (error) {
    return res.status(error.code || 500).json({
      code: error.code || 500,
      success: false,
      message: error.message,
      error: error,
    });
  }
};

const resendOTP = async (req, res) => {
  try {
    const response = await authService.resendOTP(req.body.email);
    return res.status(response.code).json({
      code: response.code,
      success: response.success,
      message: response.message,
      data: response.data,
    });
  } catch (error) {
    return res.status(error.code || 500).json({
      code: error.code || 500,
      success: false,
      message: error.message,
      error: error,
    });
  }
};

const sendPasswordResetOTP = async (req, res) => {
  try {
    const response = await authService.sendPasswordResetOTP(req.body.email);
    return res.status(response.code).json({
      code: response.code,
      success: response.success,
      message: response.message,
      data: response.data,
    });
  } catch (error) {
    return res.status(error.code || 500).json({
      code: error.code || 500,
      success: false,
      message: error.message,
      error: error,
    });
  }
};

const resetPasswordWithOTP = async (req, res) => {
  try {
    const response = await authService.resetPasswordWithOTP(
      req.body.email,
      req.body.otp,
      req.body.newPassword,
    );
    return res.status(response.code).json({
      code: response.code,
      success: response.success,
      message: response.message,
      data: response.data,
    });
  } catch (error) {
    return res.status(error.code || 500).json({
      code: error.code || 500,
      success: false,
      message: error.message,
      error: error,
    });
  }
};

const verifyUserJWT = async (req, res) => {
  try {
    const user = (await req?.user) || req.headers.authorization;

    if (!user) {
      return res.status(401).json({
        code: 401,
        success: false,
        message: "User not verified or token invalid",
        data: null,
      });
    }

    return res.status(200).json({
      code: 200,
      success: true,
      message: "User verified successfully",
      data: {
        id: user?.id,
        role: user?.role,
        is_onboarding_completed: user?.is_onboarding_completed,
        is_blocked: user?.is_blocked,
      },
    });
  } catch (error) {
    console.error("JWT Verification Error:", error);
    return res.status(error?.statusCode || 500).json({
      code: error?.statusCode || 500,
      success: false,
      message: error?.message || "Internal server error during verification",
      data: null,
    });
  }
};

const updateUserPreference = async (req, res) => {
  try {
    const response = await authService.updateUserPreference(req.body);
    return res.status(response.code).json({
      code: response.code,
      success: response.success,
      message: response.message,
      data: response.data,
    });
  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      code: error?.statusCode || 500,
      success: false,
      message: error?.message || "Internal server error during verification",
    });
  }
};

export const authController = {
  register,
  login,
  googleLogin,
  verifyOTP,
  resendOTP,
  sendPasswordResetOTP,
  resetPasswordWithOTP,
  verifyUserJWT,
  updateUserPreference,
};
