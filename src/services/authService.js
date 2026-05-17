import User from "../models/user.model.js";
import { hashPassword, comparePassword } from "../utils/hash.js";
import { Error } from "mongoose";
import jwt from "jsonwebtoken";
import createError from "http-errors";
import { OAuth2Client } from "google-auth-library";
import {
  sendPasswordResetEmail,
  sendResendOTPEmail,
} from "../utils/email.js";
import config from "../config/env.js";
import { generateToken } from "../utils/jwt.js";
import { stripeService } from "./stripeService.js";

var googleClient = new OAuth2Client(config.google.clientId);

// Generate a 6-digit OTP
export function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Register a new user
 * @param {Object} payload - User registration data
 * @param {string} payload.first_name - User's first name
 * @param {string} payload.last_name - User's last name (optional)
 * @param {string} payload.email - User's email
 * @param {string} payload.password - User's password
 * @param {string} [payload.role='USER'] - User's role (default: 'USER')
 * @returns {Promise<Object>} - The created user object (without sensitive data)
 * @throws {Error} - If validation fails or user already exists
 */
const register = async (payload) => {
  try {
    // Check if user with email already exists
    const existingUser = await User.findOne({ email: payload.email });
    if (existingUser) throw createError(409, "email-already-exists");

    // Hash the password
    const hashedPassword = await hashPassword(payload.password);

    // Create new user with hashed password
    const user = await User.create({
      ...payload,
      password: hashedPassword,
      is_verified: true,
      role: "USER", // Default role to USER if not provided
    });

    // Start 14-day free trial without blocking registration.
    stripeService.startFreeTrial(user._id).catch((err) => {
      console.error("[Billing] Failed to start free trial for user", user._id, err.message);
    });

    // Convert to plain object and remove sensitive data
    const userObject = user.toObject();
    delete userObject.password;
    delete userObject.__v;
    delete userObject.otp;
    delete userObject.otp_expiry;
    delete userObject.reset_otp;
    delete userObject.reset_otp_expiry;

    return {
      code: 201,
      success: true,
      message: "user-registered-successfully",
      data: userObject,
    };
  } catch (error) {
    // Handle duplicate key error (unique constraint)
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      const err = new Error(`${field} already exists`);
      err.statusCode = 400;
      throw err;
    }

    // Handle validation errors
    if (error instanceof Error.ValidationError) {
      const messages = Object.values(error.errors).map((err) => err.message);
      const err = new Error(messages.join(", "));
      err.statusCode = 400;
      throw err;
    }

    // Re-throw the error with status code if already set
    if (error.statusCode) throw error;

    // For any other errors, log and throw a generic error
    console.error("Registration error:", error);
    const err = new Error("Registration failed. Please try again.");
    err.statusCode = 500;
    throw err;
  }
};

/**
 * User login
 * @param {Object} payload - Login credentials
 * @param {string} payload.email - User's email
 * @param {string} payload.password - User's password
 * @returns {Promise<Object>} - User data with access token
 * @throws {Error} - If validation fails or credentials are invalid
 */
const login = async (payload) => {
  try {
    const { email, password } = payload;

    // Validate input
    if (!email || !password) {
      return {
        code: 400,
        success: false,
        message: "email-and-password-required",
      };
    }

    // Find user by email
    const user = await User.findOne({ email }).select("+password");

    // Check if user exists
    if (!user) {
      return {
        code: 401,
        success: false,
        message: "user-not-found",
      };
    }

    if (user.is_blocked) {
      return {
        code: 403,
        success: false,
        message: "account-blocked",
      };
    }

    if (user.is_deleted) {
      return {
        code: 403,
        success: false,
        message: "account-deleted",
      };
    }

    // Verify password
    const isPasswordValid = await comparePassword(password, user.password);
    if (!isPasswordValid) {
      return {
        code: 401,
        success: false,
        message: "wrong-password",
      };
    }

    // Generate JWT token
    const token = jwt.sign(
      { sub: user._id, role: user.role },
      process.env.JWT_SECRET || "your-secret-key",
      { expiresIn: process.env.JWT_EXPIRES_IN || "24h" },
    );

    // Prepare user data for response
    const userData = user.toObject();
    delete userData.password;
    delete userData.__v;
    delete userData.otp;
    delete userData.otp_expiry;
    delete userData.reset_otp;
    delete userData.reset_otp_expiry;

    const role = user.role;

    let redirect = `/dashboard/u/${user._id}`;

    role === "ADMIN" && (redirect = `/dashboard/a/${user._id}`);

    return {
      code: 200,
      success: true,
      message: "Login successful",
      data: {
        user: userData,
        redirect: redirect,
        token,
        expiresIn: process.env.JWT_EXPIRES_IN || "24h",
      },
    };
  } catch (error) {
    console.error("Login error:", error);
    return {
      code: 500,
      success: false,
      message: "Login failed. Please try again later.",
    };
  }
};

/**
 * Verify One-Time Password (OTP) for user
 * @param {Object} payload - Verification payload
 * @param {string} payload.email - User's email
 * @param {string} payload.otp - One-time password
 * @returns {Promise<Object>} - Response with minimal user info and token
 * @throws {Error} - If validation fails or credentials are invalid
 */
const verifyOTP = async ({ email, otp }) => {
  try {
    console.log("My Email ====> ", email);
    // 🔍 Find user by email
    const user = await User.findOne({ email });
    if (!user) {
      return {
        code: 401,
        success: false,
        message: "user-not-found",
      };
    }

    // 🔐 Compare OTP
    const match = otp === user.otp;
    console.log("input OTP ====> ", otp);
    console.log("User OTP =====> ", user);
    const isOTPExpired = user.otp_expiry < new Date();
    if (!match) {
      return {
        code: 401,
        success: false,
        message: "invalid-otp",
      };
    }

    if (isOTPExpired) {
      return {
        code: 401,
        success: false,
        message: "otp-expired",
      };
    }

    // ✅ OTP verified successfully — update user
    await User.findOneAndUpdate(
      { email },
      {
        is_verified: true,
        otp: null,
        otp_expiry: null,
      },
    );

    // 🟢 Return minimal user info + token
    return {
      code: 200,
      success: true,
      message: "otp-verified-successfully",
      data: {},
    };
  } catch (error) {
    console.error("Verify OTP Error:", error);
    throw error;
  }
};

/**
 * Resend a new OTP to the user's email address
 * @param {string} email - User's email address
 * @returns {Promise<Object>} - Response object with code, success, message, and data
 * @throws {Error} - If user is not found or already verified
 */

const resendOTP = async (email) => {
  try {
    // Find user by email
    const user = await User.findOne({ email });

    if (!user) {
      return {
        code: 404,
        success: false,
        message: "user-not-found",
      };
    }

    if (user.is_verified) {
      return {
        code: 400,
        success: false,
        message: "user-already-verified",
      };
    }

    // Generate new OTP (6 digits)
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes from now

    // Update user with new OTP
    await User.findOneAndUpdate(
      { email },
      {
        otp,
        otp_expiry: otpExpiry,
      },
    );

    // Send the OTP via email

    await sendResendOTPEmail(email, otp);

    return {
      code: 200,
      success: true,
      message: "otp-sent-successfully",
      data: {
        email,
      },
    };
  } catch (error) {
    console.error("Resend OTP Service Error:", error);
    throw error;
  }
};

/**
 * Sends a password reset OTP to the user's email address
 *
 * @param {string} email - User's email address
 *
 * @returns {Promise<Object>} - Response object with code, success, message, and data
 *
 * @throws {Error} - If user is not found
 */
const sendPasswordResetOTP = async (email) => {
  try {
    const user = await User.findOne({ email });
    if (!user) {
      return {
        code: 401,
        success: false,
        message: "user-not-found",
      };
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes expiry

    // Store OTP in database
    await User.findOneAndUpdate(
      { email },
      {
        reset_otp: otp,
        reset_otp_expiry: otpExpiry,
      },
    );

    // Send OTP via email
    await sendPasswordResetEmail(email, otp);

    return {
      code: 200,
      success: true,
      message: "otp-sent-successfully",
      data: { email },
    };
  } catch (error) {
    console.error("Send Password Reset OTP Error:", error);
    throw error;
  }
};

/**
 * Verify password reset OTP
 * @param {string} email - User email address
 * @param {string} otp - One-time password
 * @returns {boolean} true if OTP is valid, false otherwise
 */
const verifyPasswordResetOTP = async (email, otp) => {
  try {
    const user = await User.findOne({
      email,
      reset_otp: otp,
      reset_otp_expiry: {
        $gte: new Date(),
      },
    });

    return !!user;
  } catch (error) {
    console.error("Verify Password Reset OTP Error:", error);
    throw error;
  }
};

const resetPasswordWithOTP = async (email, otp, newPassword) => {
  try {
    // Verify OTP first
    const isValid = await verifyPasswordResetOTP(email, otp);
    if (!isValid) {
      return {
        code: 401,
        success: false,
        message: "invalid-otp",
      };
    }

    // Hash the new password
    const hashedPassword = await hashPassword(newPassword);

    // Update password and clear OTP
    await User.findOneAndUpdate(
      { email },
      {
        password: hashedPassword,
        reset_otp: null,
        reset_otp_expiry: null,
      },
    );

    return {
      code: 200,
      success: true,
      message: "password-reset-successfully",
      data: {},
    };
  } catch (error) {
    console.error("Reset Password With OTP Error:", error);
    throw error;
  }
};

/**
 * Google Sign-In
 * @param {Object} params - Object containing Google credential
 * @param {string} params.credential - Google credential
 * @returns {Promise<Object>} - Response object with code, success, message, data, and token
 * @throws {Error} - If Google credential is missing or sign-in fails
 */
const googleLogin = async ({ credential }) => {
  let token;
  let redirect;

  if (!credential)
    return {
      success: false,
      message: "google-creds-missing",
    };

  const ticket = await googleClient.verifyIdToken({
    idToken: credential,
    audience: config.google.clientId,
  });

  if (!ticket)
    return {
      success: false,
      message: "signin-failed",
      data: null,
    };

  const payload = ticket.getPayload();
  const { email, given_name, picture, family_name } = payload;

  const user = await User.findOne({
    email,
  });

  if (user) {
    redirect =
      user.role === "ADMIN"
        ? `/dashboard/a/${user._id}`
        : `/dashboard/u/${user._id}`;
    token = generateToken(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        blocked: user.blocked,
        type: "user",
      },
      "1h",
    );

    return {
      success: true,
      code: 200,
      message: "sign-in-successful",
      data: {
        user,
        redirect,
        token,
      },
    };
  }

  const hashedPassword = await hashPassword(email);

  const newUser = await User.create({
    first_name: given_name,
    last_name: family_name,
    email: email,
    role: "USER",
    password: hashedPassword,
    is_verified: true,
    is_blocked: false,
    is_notifications_enabled: true,
    is_update_enabled: true,
    avatar_url: picture,
    auth_provider: "google",
  });
  token = generateToken(
    {
      sub: newUser.id,
      email: newUser.email,
      role: newUser.role,
      blocked: newUser.blocked,
      type: "user",
    },
    "1h",
  );

  redirect =
    newUser.role === "ADMIN"
      ? `/dashboard/a/${newUser._id}`
      : `/dashboard/u/${newUser._id}`;

  return {
    code: 200,
    success: true,
    message: "sign-in-successful",
    data: {
      redirect,
      token,
      user: newUser,
    },
  };
};

/**
 * Update user preferences
 * @param {Object} payload - User preference data
 * @param {string} payload.user_id - User ID
 * @param {boolean} payload.is_notifications_enabled - Whether notifications are enabled
 * @param {boolean} payload.is_update_enabled - Whether update notifications are enabled
 * @returns {Promise<Object>} - Response with success flag, message, and data
 * @throws {Error} - If validation fails or user preference cannot be updated
 */
const updateUserPreference = async (payload) => {
  try {
    const { user_id, is_notifications_enabled, is_update_enabled } = payload;

    if (!user_id) {
      return {
        code: 400,
        success: false,
        message: "user-id-required",
      };
    }

    const user = await User.findByIdAndUpdate(user_id, {
      is_notifications_enabled,
      is_update_enabled,
    });
    return {
      code: 200,
      success: true,
      message: "user-preference-updated-successfully",
      data: user,
    };
  } catch (error) {
    console.error("Update User Preference Error:", error);
    throw error;
  }
};

export const authService = {
  register,
  login,
  verifyOTP,
  googleLogin,
  resendOTP,
  sendPasswordResetOTP,
  resetPasswordWithOTP,
  updateUserPreference,
};
