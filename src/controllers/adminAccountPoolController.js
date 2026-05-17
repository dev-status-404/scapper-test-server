import InstagramAccount from "../models/instagramAccount.model.js";
import accountPool from "../services/accountPoolService.js";
import { getNextProxyConfig, proxyConfigToUrl } from "../config/instagram-proxy.js";
import ApiError from "../utils/ApiError.js";
import httpStatus from "http-status";

const MAX_POOL_ACCOUNTS = 10;

// ─── helpers (same logic as migration script) ─────────────────────────────────

function extractInstagramUserIdFromCookies(cookies) {
  const dsUser = cookies.find((c) => c.name === "ds_user_id");
  if (dsUser) return dsUser.value;
  const session = cookies.find((c) => c.name === "sessionid");
  if (session) {
    const match = session.value.match(/^(\d+)/);
    if (match) return match[1];
  }
  return null;
}

function validateCookies(cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0)
    return { valid: false, reason: "Cookies array is empty or invalid" };
  if (!cookies.some((c) => c.name === "sessionid"))
    return { valid: false, reason: "Missing required cookie: sessionid" };
  if (!cookies.some((c) => c.name === "csrftoken"))
    return { valid: false, reason: "Missing required cookie: csrftoken" };
  return { valid: true };
}

function normalizeCookies(cookies) {
  return cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain || ".instagram.com",
    path: c.path || "/",
    expires: c.expires ?? c.expirationDate ?? -1,
    httpOnly: c.httpOnly ?? false,
    secure: c.secure ?? true,
    sameSite: c.sameSite || "None",
  }));
}

// ─── GET /api/admin/account-pool  ─────────────────────────────────────────────
export const adminGetAllAccounts = async (req, res, next) => {
  try {
    const accounts = await InstagramAccount.find({})
      .select("-encryptedCookies")
      .sort({ priority: -1, createdAt: -1 })
      .lean();

    const total = accounts.length;

    res.json({
      success: true,
      data: { accounts, total, limit: MAX_POOL_ACCOUNTS },
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /api/admin/account-pool  ────────────────────────────────────────────
export const adminAddAccount = async (req, res, next) => {
  try {
    // Enforce hard cap
    const existingCount = await InstagramAccount.countDocuments({});
    if (existingCount >= MAX_POOL_ACCOUNTS) {
      throw new ApiError(
        httpStatus.UNPROCESSABLE_ENTITY,
        `Account pool is full. Maximum ${MAX_POOL_ACCOUNTS} accounts allowed. Remove an existing account first.`,
      );
    }

    const { cookies: rawCookies, displayName, notes } = req.body;

    // Accept JSON string or parsed array
    let cookies = rawCookies;
    if (typeof rawCookies === "string") {
      try {
        cookies = JSON.parse(rawCookies);
      } catch {
        throw new ApiError(httpStatus.BAD_REQUEST, "Invalid JSON in cookies field");
      }
    }

    const validation = validateCookies(cookies);
    if (!validation.valid) {
      throw new ApiError(httpStatus.BAD_REQUEST, validation.reason);
    }

    const instagramUserId = extractInstagramUserIdFromCookies(cookies);
    if (!instagramUserId) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        "Could not extract Instagram user ID from cookies. Make sure ds_user_id or sessionid cookie is present.",
      );
    }

    // Duplicate check
    const existing = await InstagramAccount.findOne({ instagramUserId });
    if (existing) {
      throw new ApiError(
        httpStatus.CONFLICT,
        `An account with Instagram ID ${instagramUserId} already exists (@${existing.username}).`,
      );
    }

    const normalizedCookies = normalizeCookies(cookies);

    // Auto-assign next proxy port (round-robin based on current pool size)
    const proxyConfig = getNextProxyConfig();
    const proxyUrl = proxyConfigToUrl(proxyConfig);

    // Generate placeholder username from Instagram user ID
    const username = `ig_pool_${instagramUserId.slice(-6)}`;

    const account = new InstagramAccount({
      userId: req.user._id, // admin user owns the pool account
      username,
      instagramUserId,
      displayName: displayName || `Pool Account #${existingCount + 1}`,
      priority: 1,
      status: "active",
      isAvailable: true,
      proxyUrl,
      notes: notes || `Added by admin on ${new Date().toISOString()}. Proxy: ${proxyConfig.host}:${proxyConfig.port}`,
    });

    account.setCookies(normalizedCookies);
    await account.save();
    accountPool.clearCache();

    res.status(httpStatus.CREATED).json({
      success: true,
      message: "Account added to pool successfully",
      data: {
        ...account.toObject({ virtuals: false }),
        encryptedCookies: undefined,
        cookieCount: normalizedCookies.length,
        assignedProxy: `${proxyConfig.host}:${proxyConfig.port}`,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── PUT /api/admin/account-pool/:id/cookies  ─────────────────────────────────
export const adminUpdateCookies = async (req, res, next) => {
  try {
    const { id } = req.params;
    let { cookies: rawCookies } = req.body;

    if (typeof rawCookies === "string") {
      try {
        rawCookies = JSON.parse(rawCookies);
      } catch {
        throw new ApiError(httpStatus.BAD_REQUEST, "Invalid JSON in cookies field");
      }
    }

    const validation = validateCookies(rawCookies);
    if (!validation.valid) {
      throw new ApiError(httpStatus.BAD_REQUEST, validation.reason);
    }

    const account = await InstagramAccount.findById(id);
    if (!account) throw new ApiError(httpStatus.NOT_FOUND, "Account not found");

    account.setCookies(normalizeCookies(rawCookies));
    account.status = "active";
    account.isAvailable = true;
    account.consecutiveFailures = 0;
    account.rateLimitUntil = null;
    await account.save();
    accountPool.clearCache();

    res.json({ success: true, message: "Cookies updated successfully" });
  } catch (err) {
    next(err);
  }
};

// ─── PATCH /api/admin/account-pool/:id  ───────────────────────────────────────
export const adminUpdateAccount = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { displayName, priority, status, isAvailable, proxyUrl, notes } = req.body;

    const account = await InstagramAccount.findById(id);
    if (!account) throw new ApiError(httpStatus.NOT_FOUND, "Account not found");

    if (displayName !== undefined) account.displayName = displayName;
    if (priority !== undefined) account.priority = priority;
    if (status !== undefined) account.status = status;
    if (isAvailable !== undefined) account.isAvailable = isAvailable;
    if (proxyUrl !== undefined) account.proxyUrl = proxyUrl;
    if (notes !== undefined) account.notes = notes;

    await account.save();
    accountPool.clearCache();

    res.json({ success: true, message: "Account updated", data: account });
  } catch (err) {
    next(err);
  }
};

// ─── DELETE /api/admin/account-pool/:id  ──────────────────────────────────────
export const adminDeleteAccount = async (req, res, next) => {
  try {
    const { id } = req.params;
    const account = await InstagramAccount.findByIdAndDelete(id);
    if (!account) throw new ApiError(httpStatus.NOT_FOUND, "Account not found");

    accountPool.clearCache();
    res.json({ success: true, message: "Account removed from pool" });
  } catch (err) {
    next(err);
  }
};

// ─── POST /api/admin/account-pool/:id/reset  ──────────────────────────────────
export const adminResetAccount = async (req, res, next) => {
  try {
    const { id } = req.params;
    const account = await InstagramAccount.findById(id);
    if (!account) throw new ApiError(httpStatus.NOT_FOUND, "Account not found");

    account.consecutiveFailures = 0;
    account.status = "active";
    account.isAvailable = true;
    account.rateLimitUntil = null;
    await account.save();
    accountPool.clearCache();

    res.json({ success: true, message: "Account reset to active" });
  } catch (err) {
    next(err);
  }
};
