import InstagramAccount from "../models/instagramAccount.model.js";
import accountPool from "../services/accountPoolService.js";
import ApiError from "../utils/ApiError.js";
import httpStatus from "http-status";

/**
 * Add a new Instagram account to the pool
 */
export const addAccount = async (req, res, next) => {
  try {
    const {
      username,
      instagramUserId,
      displayName,
      cookies,
      priority,
      proxyUrl,
      notes,
    } = req.body;

    // Validate cookies format
    if (!Array.isArray(cookies) || cookies.length === 0) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        "Invalid cookies format. Expected non-empty array.",
      );
    }

    // Check if account already exists
    const existing = await InstagramAccount.findOne({ username });
    if (existing) {
      throw new ApiError(
        httpStatus.CONFLICT,
        `Account @${username} already exists.`,
      );
    }

    // Create new account
    const account = new InstagramAccount({
      userId: req.user._id,
      username,
      instagramUserId,
      displayName: displayName || username,
      priority: priority || 1,
      proxyUrl,
      notes,
    });

    // Set encrypted cookies
    account.setCookies(cookies);

    await account.save();

    // Refresh pool cache
    accountPool.clearCache();

    res.status(httpStatus.CREATED).json({
      success: true,
      message: "Instagram account added successfully",
      data: account,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get all Instagram accounts for current user
 */
export const getAccounts = async (req, res, next) => {
  try {
    const { status, isAvailable } = req.query;

    const filter = { userId: req.user._id };
    if (status) filter.status = status;
    if (isAvailable !== undefined) filter.isAvailable = isAvailable === "true";

    const accounts = await InstagramAccount.find(filter)
      .select("-encryptedCookies")
      .sort({ priority: -1, createdAt: -1 });

    const stats = await InstagramAccount.getAccountStats(req.user._id);

    res.json({
      success: true,
      data: {
        accounts,
        stats,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get single account details
 */
export const getAccount = async (req, res, next) => {
  try {
    const { id } = req.params;

    const account = await InstagramAccount.findOne({
      _id: id,
      userId: req.user._id,
    }).select("-encryptedCookies");

    if (!account) {
      throw new ApiError(httpStatus.NOT_FOUND, "Account not found");
    }

    res.json({
      success: true,
      data: account,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Update account settings (not cookies)
 */
export const updateAccount = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { displayName, priority, status, isAvailable, proxyUrl, notes } =
      req.body;

    const account = await InstagramAccount.findOne({
      _id: id,
      userId: req.user._id,
    });

    if (!account) {
      throw new ApiError(httpStatus.NOT_FOUND, "Account not found");
    }

    // Update allowed fields
    if (displayName !== undefined) account.displayName = displayName;
    if (priority !== undefined) account.priority = priority;
    if (status !== undefined) account.status = status;
    if (isAvailable !== undefined) account.isAvailable = isAvailable;
    if (proxyUrl !== undefined) account.proxyUrl = proxyUrl;
    if (notes !== undefined) account.notes = notes;

    await account.save();

    // Refresh pool cache
    accountPool.clearCache();

    res.json({
      success: true,
      message: "Account updated successfully",
      data: account,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Update account cookies
 */
export const updateCookies = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { cookies } = req.body;

    if (!Array.isArray(cookies) || cookies.length === 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, "Invalid cookies format");
    }

    const account = await InstagramAccount.findOne({
      _id: id,
      userId: req.user._id,
    });

    if (!account) {
      throw new ApiError(httpStatus.NOT_FOUND, "Account not found");
    }

    account.setCookies(cookies);
    account.status = "active";
    account.isAvailable = true;
    account.consecutiveFailures = 0;

    await account.save();

    // Refresh pool cache
    accountPool.clearCache();

    res.json({
      success: true,
      message: "Cookies updated successfully",
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Delete account
 */
export const deleteAccount = async (req, res, next) => {
  try {
    const { id } = req.params;

    const account = await InstagramAccount.findOneAndDelete({
      _id: id,
      userId: req.user._id,
    });

    if (!account) {
      throw new ApiError(httpStatus.NOT_FOUND, "Account not found");
    }

    // Refresh pool cache
    accountPool.clearCache();

    res.json({
      success: true,
      message: "Account deleted successfully",
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Test account (verify cookies work)
 */
export const testAccount = async (req, res, next) => {
  try {
    const { id } = req.params;

    const account = await InstagramAccount.findOne({
      _id: id,
      userId: req.user._id,
    });

    if (!account) {
      throw new ApiError(httpStatus.NOT_FOUND, "Account not found");
    }

    // Simply try to decrypt cookies as a basic test
    const cookies = account.getCookies();

    if (!cookies || !Array.isArray(cookies)) {
      throw new ApiError(httpStatus.BAD_REQUEST, "Failed to decrypt cookies");
    }

    // Check for essential cookies
    const hasSessionId = cookies.some((c) => c.name === "sessionid");
    const hasCsrfToken = cookies.some((c) => c.name === "csrftoken");

    if (!hasSessionId || !hasCsrfToken) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        "Missing essential cookies (sessionid or csrftoken)",
      );
    }

    res.json({
      success: true,
      message: "Account cookies are valid",
      data: {
        cookieCount: cookies.length,
        hasSessionId,
        hasCsrfToken,
        username: account.username,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get pool statistics
 */
export const getPoolStats = async (req, res, next) => {
  try {
    const stats = await accountPool.getStats();

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Perform health check on all accounts
 */
export const performHealthCheck = async (req, res, next) => {
  try {
    const result = await accountPool.performHealthCheck();

    res.json({
      success: true,
      message: "Health check completed",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Reset account failures (admin feature)
 */
export const resetFailures = async (req, res, next) => {
  try {
    const { id } = req.params;

    const account = await InstagramAccount.findOne({
      _id: id,
      userId: req.user._id,
    });

    if (!account) {
      throw new ApiError(httpStatus.NOT_FOUND, "Account not found");
    }

    account.consecutiveFailures = 0;
    account.status = "active";
    account.isAvailable = true;
    account.rateLimitUntil = null;

    await account.save();

    // Refresh pool cache
    accountPool.clearCache();

    res.json({
      success: true,
      message: "Account failures reset successfully",
      data: account,
    });
  } catch (error) {
    next(error);
  }
};
