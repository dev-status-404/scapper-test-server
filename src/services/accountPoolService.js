import InstagramAccount from "../models/instagramAccount.model.js";
import { logMemoryUsage } from "../utils/memoryMonitor.js";

const ACCOUNT_RATE_LIMIT_COOLDOWN_MINUTES = parseInt(
  process.env.INSTAGRAM_ACCOUNT_RATE_LIMIT_COOLDOWN_MINUTES || "90",
  10,
);
const ACCOUNT_AUTH_ERROR_COOLDOWN_MINUTES = parseInt(
  process.env.INSTAGRAM_ACCOUNT_AUTH_ERROR_COOLDOWN_MINUTES || "720",
  10,
);
const ACCOUNT_MAX_REQUESTS_PER_HOUR = parseInt(
  process.env.INSTAGRAM_ACCOUNT_MAX_REQUESTS_PER_HOUR || "120",
  10,
);

/**
 * Account Pool Service
 * Manages Instagram account rotation with caching and health monitoring
 * Optimized for low resource usage and maximum scalability
 */
class AccountPoolService {
  constructor() {
    // In-memory cache for active accounts (lightweight)
    this.accountCache = new Map();
    this.cacheExpiry = 5 * 60 * 1000; // 5 minutes cache TTL
    this.lastCacheUpdate = null;

    // Lock mechanism to prevent concurrent account selection
    this.accountLocks = new Set();

    // Statistics tracking (lightweight counters)
    this.stats = {
      cacheHits: 0,
      cacheMisses: 0,
      accountRotations: 0,
    };
  }

  /**
   * Get or refresh account cache
   * @private
   */
  async _refreshCache(force = false) {
    const now = Date.now();

    // Check if cache is still valid
    if (
      !force &&
      this.lastCacheUpdate &&
      now - this.lastCacheUpdate < this.cacheExpiry
    ) {
      this.stats.cacheHits++;
      return Array.from(this.accountCache.values());
    }

    this.stats.cacheMisses++;

    // Fetch only active/available accounts to minimize memory
    const accounts = await InstagramAccount.find({
      isAvailable: true,
      status: { $in: ["active", "rate_limited"] },
    })
      .select(
        "_id userId username instagramUserId status isAvailable lastUsedAt priority requestsThisHour hourResetAt rateLimitUntil",
      )
      .lean()
      .exec();

    // Update cache
    this.accountCache.clear();
    accounts.forEach((account) => {
      // Check rate limit expiry
      if (
        account.rateLimitUntil &&
        new Date(account.rateLimitUntil) < new Date()
      ) {
        account.status = "active";
        account.isAvailable = true;
      }

      if (account.isAvailable && account.status === "active") {
        this.accountCache.set(account._id.toString(), account);
      }
    });

    this.lastCacheUpdate = now;

    return Array.from(this.accountCache.values());
  }

  /**
   * Get next available account from pool using round-robin with priority
   * @param {string} userId - Optional user ID to filter accounts
   * @returns {Promise<Object>} Account document with decrypted cookies
   */
  async getNextAccount(
    userId = null,
    {
      waitForUnlock = true,
      waitTimeoutMs = parseInt(process.env.INSTAGRAM_ACCOUNT_WAIT_TIMEOUT_MS || "30000", 10),
      waitPollMs = parseInt(process.env.INSTAGRAM_ACCOUNT_WAIT_POLL_MS || "250", 10),
    } = {},
  ) {
    try {
      // Refresh cache if needed
      await this._refreshCache();

      const filterHourlyBudget = (accounts) => {
        const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
        return accounts.filter(
          (acc) =>
            !acc.hourResetAt ||
            new Date(acc.hourResetAt) < hourAgo ||
            (acc.requestsThisHour || 0) < ACCOUNT_MAX_REQUESTS_PER_HOUR,
        );
      };

      // Get available accounts from cache
      let availableAccounts = filterHourlyBudget(
        Array.from(this.accountCache.values()),
      );

      if (availableAccounts.length === 0) {
        console.log(
          "[AccountPool] No cached accounts within hourly budget, fetching from DB...",
        );
        await this._refreshCache(true);
        availableAccounts = filterHourlyBudget(
          Array.from(this.accountCache.values()),
        );
      }

      if (availableAccounts.length === 0) {
        throw new Error(
          "No Instagram accounts available within rate budget. Please wait for account cooldown.",
        );
      }

      // Filter by userId if provided (with fallback to shared accounts)
      if (userId) {
        const userAccounts = availableAccounts.filter(
          (acc) => acc.userId?.toString() === userId.toString(),
        );

        if (userAccounts.length > 0) {
          // User has their own Instagram accounts - use them
          availableAccounts = userAccounts;
          console.log(
            `[AccountPool] Using ${userAccounts.length} account(s) for user ${userId}`,
          );
        } else {
          // No user-specific accounts - use shared pool
          console.log(
            `[AccountPool] No accounts for user ${userId}, using shared pool (${availableAccounts.length} available)`,
          );
        }
      }

      const waitStartedAt = Date.now();
      let loggedAccountWait = false;
      while (true) {
        availableAccounts = availableAccounts.filter(
          (acc) => !this.accountLocks.has(acc._id.toString()),
        );

        if (availableAccounts.length > 0) {
          break;
        }

        if (!waitForUnlock || Date.now() - waitStartedAt >= waitTimeoutMs) {
          throw new Error("No unlocked Instagram accounts available before timeout.");
        }

        if (!loggedAccountWait) {
          console.log(
            JSON.stringify({
              event: "instagram_account_pool_waiting_for_unlock",
              user_id: userId || null,
              wait_timeout_ms: waitTimeoutMs,
              wait_poll_ms: waitPollMs,
            }),
          );
          loggedAccountWait = true;
        }

        await new Promise((resolve) => setTimeout(resolve, waitPollMs));
        await this._refreshCache(true);
        availableAccounts = filterHourlyBudget(Array.from(this.accountCache.values()));

        if (userId) {
          const userAccounts = availableAccounts.filter(
            (acc) => acc.userId?.toString() === userId.toString(),
          );
          if (userAccounts.length > 0) {
            availableAccounts = userAccounts;
          }
        }
      }

      // Sort by: priority (desc), lastUsedAt (asc - least recently used first)
      availableAccounts.sort((a, b) => {
        if (a.priority !== b.priority) {
          return b.priority - a.priority;
        }
        const aTime = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0;
        const bTime = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0;
        return aTime - bTime;
      });

      // Select first account (highest priority, least recently used)
      const selectedId = availableAccounts[0]._id.toString();

      // Lock the account
      this.accountLocks.add(selectedId);

      // Fetch full account with cookies (not cached for security)
      const account = await InstagramAccount.findById(selectedId);

      if (!account) {
        this.accountLocks.delete(selectedId);
        this.accountCache.delete(selectedId);
        throw new Error("Selected account not found in database.");
      }

      // Mark as used
      account.markUsed();
      await account.save();

      // Update cache
      this.accountCache.set(selectedId, {
        ...account.toObject(),
        lastUsedAt: account.lastUsedAt,
      });

      this.stats.accountRotations++;

      console.log(
        `[AccountPool] Selected account: @${account.username} (ID: ${selectedId.slice(-6)})`,
      );

      return account;
    } catch (error) {
      console.error("[AccountPool] Error getting account:", error.message);
      throw error;
    }
  }

  /**
   * Release account lock after use
   * @param {string} accountId - Account ID to release
   * @param {boolean} success - Whether the operation was successful
   * @param {string} reason - Reason for failure (if any)
   */
  async releaseAccount(accountId, success = true, reason = null) {
    try {
      const idStr = accountId.toString();
      this.accountLocks.delete(idStr);

      const account = await InstagramAccount.findById(accountId);
      if (!account) return;

      if (success) {
        account.markSuccess();
      } else {
        account.lastFailureAt = new Date();
        account.failedRequests += 1;
        account.consecutiveFailures += 1;

        if (reason === "rate_limit") {
          account.setRateLimit(ACCOUNT_RATE_LIMIT_COOLDOWN_MINUTES);
          console.warn(
            `[AccountPool] Cooling @${account.username} for ${ACCOUNT_RATE_LIMIT_COOLDOWN_MINUTES} minute(s) after rate limit`,
          );
        } else if (reason === "auth_error") {
          account.setRateLimit(ACCOUNT_AUTH_ERROR_COOLDOWN_MINUTES);
          console.warn(
            `[AccountPool] Cooling @${account.username} for ${ACCOUNT_AUTH_ERROR_COOLDOWN_MINUTES} minute(s) after auth/session rejection`,
          );
        } else {
          if (account.consecutiveFailures >= 3) {
            account.isAvailable = false;
            account.status = "error";
          }
        }

        // Remove from cache if no longer available
        if (!account.isAvailable) {
          this.accountCache.delete(idStr);
        }
      }

      await account.save();

      // Update cache
      if (account.isAvailable && account.status === "active") {
        this.accountCache.set(idStr, account.toObject());
      }

      console.log(
        `[AccountPool] Released account: @${account.username} (Success: ${success})`,
      );
    } catch (error) {
      console.error("[AccountPool] Error releasing account:", error.message);
    }
  }

  /**
   * Record requests that happened after an account was selected.
   * getNextAccount() already records the first request for the session.
   */
  async recordAdditionalRequests(accountId, additionalCount = 0) {
    const count = Number.parseInt(additionalCount, 10);
    if (!accountId || !Number.isFinite(count) || count <= 0) return;

    try {
      const idStr = accountId.toString();
      const account = await InstagramAccount.findById(accountId);
      if (!account) return;

      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
      if (!account.hourResetAt || account.hourResetAt < hourAgo) {
        account.requestsThisHour = count;
        account.hourResetAt = new Date();
      } else {
        account.requestsThisHour += count;
      }

      account.totalRequests += count;
      await account.save();

      if (account.isAvailable && account.status === "active") {
        this.accountCache.set(idStr, account.toObject());
      }
    } catch (error) {
      console.error(
        "[AccountPool] Error recording additional requests:",
        error.message,
      );
    }
  }

  /**
   * Execute a function with automatic account selection and release
   * @param {Function} fn - Async function that receives account as parameter
   * @param {string} userId - Optional user ID
   * @returns {Promise<any>} Result from the function
   */
  async withAccount(fn, userId = null) {
    let account = null;

    try {
      account = await this.getNextAccount(userId);
      const result = await fn(account);
      await this.releaseAccount(account._id, true);
      return result;
    } catch (error) {
      if (account) {
        const isRateLimit = error.message?.toLowerCase().includes("rate limit");
        await this.releaseAccount(
          account._id,
          false,
          isRateLimit ? "rate_limit" : "error",
        );
      }
      throw error;
    }
  }

  /**
   * Get pool statistics
   */
  async getStats() {
    const dbStats = await InstagramAccount.getAccountStats();

    return {
      database: dbStats,
      cache: {
        size: this.accountCache.size,
        hits: this.stats.cacheHits,
        misses: this.stats.cacheMisses,
        hitRate:
          this.stats.cacheHits + this.stats.cacheMisses > 0
            ? (
                (this.stats.cacheHits /
                  (this.stats.cacheHits + this.stats.cacheMisses)) *
                100
              ).toFixed(2) + "%"
            : "0%",
        lastUpdate: this.lastCacheUpdate
          ? new Date(this.lastCacheUpdate).toISOString()
          : null,
      },
      runtime: {
        accountRotations: this.stats.accountRotations,
        lockedAccounts: this.accountLocks.size,
      },
    };
  }

  /**
   * Health check - restore accounts from rate limits
   */
  async performHealthCheck() {
    try {
      const now = new Date();

      // Find accounts with expired rate limits
      const expiredRateLimits = await InstagramAccount.find({
        status: "rate_limited",
        rateLimitUntil: { $lt: now },
      });

      let restored = 0;
      for (const account of expiredRateLimits) {
        account.checkRateLimitExpired();
        if (account.isAvailable) {
          await account.save();
          restored++;
        }
      }

      if (restored > 0) {
        console.log(
          `[AccountPool] Health Check: Restored ${restored} accounts from rate limiting`,
        );
        await this._refreshCache(true); // Force cache refresh
      }

      // Check accounts with high consecutive failures
      const failedAccounts = await InstagramAccount.find({
        consecutiveFailures: { $gte: 3 },
        status: "error",
      });

      console.log(
        `[AccountPool] Health Check: ${failedAccounts.length} accounts need attention`,
      );

      return {
        restored,
        needsAttention: failedAccounts.length,
        timestamp: now,
      };
    } catch (error) {
      console.error("[AccountPool] Health check error:", error.message);
      return { error: error.message };
    }
  }

  /**
   * Clear cache (useful for testing or manual refresh)
   */
  clearCache() {
    this.accountCache.clear();
    this.lastCacheUpdate = null;
    this.stats.cacheHits = 0;
    this.stats.cacheMisses = 0;
  }
}

// Singleton instance
const accountPool = new AccountPoolService();

// Run health check every 15 minutes
setInterval(
  () => {
    accountPool.performHealthCheck().catch(console.error);
  },
  15 * 60 * 1000,
);

export default accountPool;
