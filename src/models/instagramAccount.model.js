import mongoose from "mongoose";
import crypto from "crypto";

// IMPORTANT: COOKIE_ENCRYPTION_KEY must be set in .env for consistent encryption/decryption
if (!process.env.COOKIE_ENCRYPTION_KEY) {
  console.warn(
    "\n⚠️  WARNING: COOKIE_ENCRYPTION_KEY is not set in environment variables!\n" +
      "   This will cause cookie decryption to fail after server restarts.\n" +
      "   Generate a key with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"\n" +
      "   Then add it to your .env file.\n",
  );
}

const ENCRYPTION_KEY =
  process.env.COOKIE_ENCRYPTION_KEY || crypto.randomBytes(32).toString("hex");
const ALGORITHM = "aes-256-gcm";

// Encryption helper functions
const encrypt = (text) => {
  const iv = crypto.randomBytes(16);
  const key = Buffer.from(ENCRYPTION_KEY.slice(0, 64), "hex");
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(JSON.stringify(text), "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag();

  return {
    encrypted,
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
  };
};

const decrypt = (encryptedData) => {
  try {
    const key = Buffer.from(ENCRYPTION_KEY.slice(0, 64), "hex");
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(encryptedData.iv, "hex"),
    );

    decipher.setAuthTag(Buffer.from(encryptedData.authTag, "hex"));

    let decrypted = decipher.update(encryptedData.encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return JSON.parse(decrypted);
  } catch (error) {
    console.error("Decryption error:", error.message);
    return null;
  }
};

const instagramAccountSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    instagramUserId: {
      type: String,
      required: true,
      index: true,
    },
    displayName: {
      type: String,
      trim: true,
    },
    // Encrypted cookies stored as encrypted object
    encryptedCookies: {
      encrypted: { type: String, required: true },
      iv: { type: String, required: true },
      authTag: { type: String, required: true },
    },
    // Account status and health
    status: {
      type: String,
      enum: ["active", "inactive", "rate_limited", "suspended", "error"],
      default: "active",
      index: true,
    },
    isAvailable: {
      type: Boolean,
      default: true,
      index: true,
    },
    // Health metrics
    lastUsedAt: {
      type: Date,
      default: null,
      index: true,
    },
    lastSuccessAt: {
      type: Date,
      default: Date.now,
    },
    lastFailureAt: {
      type: Date,
      default: null,
    },
    consecutiveFailures: {
      type: Number,
      default: 0,
    },
    totalRequests: {
      type: Number,
      default: 0,
    },
    successfulRequests: {
      type: Number,
      default: 0,
    },
    failedRequests: {
      type: Number,
      default: 0,
    },
    // Rate limiting tracking
    requestsThisHour: {
      type: Number,
      default: 0,
    },
    hourResetAt: {
      type: Date,
      default: Date.now,
    },
    rateLimitUntil: {
      type: Date,
      default: null,
    },
    // Priority and rotation
    priority: {
      type: Number,
      default: 1,
      min: 0,
      max: 10,
    },
    // Additional metadata
    proxyUrl: {
      type: String,
      default: null,
    },
    notes: {
      type: String,
      default: "",
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (doc, ret) => {
        delete ret.encryptedCookies; // Never expose encrypted cookies in JSON
        delete ret.__v;
        return ret;
      },
    },
  },
);

// Indexes for performance
instagramAccountSchema.index({ userId: 1, status: 1 });
instagramAccountSchema.index({ isAvailable: 1, priority: -1, lastUsedAt: 1 });
instagramAccountSchema.index({ status: 1, isAvailable: 1 });

// Instance methods
instagramAccountSchema.methods.setCookies = function (cookies) {
  this.encryptedCookies = encrypt(cookies);
};

instagramAccountSchema.methods.getCookies = function () {
  return decrypt(this.encryptedCookies);
};

instagramAccountSchema.methods.markUsed = function () {
  this.lastUsedAt = new Date();
  this.totalRequests += 1;
  this.requestsThisHour += 1;

  // Reset hourly counter if hour has passed
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  if (this.hourResetAt < hourAgo) {
    this.requestsThisHour = 1;
    this.hourResetAt = new Date();
  }
};

instagramAccountSchema.methods.markSuccess = function () {
  this.lastSuccessAt = new Date();
  this.successfulRequests += 1;
  this.consecutiveFailures = 0;
  this.status = "active";
  this.isAvailable = true;
};

instagramAccountSchema.methods.markFailure = function (reason = "error") {
  this.lastFailureAt = new Date();
  this.failedRequests += 1;
  this.consecutiveFailures += 1;

  // Auto-disable after 3 consecutive failures
  if (this.consecutiveFailures >= 3) {
    this.isAvailable = false;
    this.status = reason === "rate_limit" ? "rate_limited" : "error";
  }
};

instagramAccountSchema.methods.setRateLimit = function (durationMinutes = 60) {
  this.status = "rate_limited";
  this.isAvailable = false;
  this.rateLimitUntil = new Date(Date.now() + durationMinutes * 60 * 1000);
};

instagramAccountSchema.methods.checkRateLimitExpired = function () {
  if (this.rateLimitUntil && this.rateLimitUntil < new Date()) {
    this.status = "active";
    this.isAvailable = true;
    this.rateLimitUntil = null;
    return true;
  }
  return false;
};

instagramAccountSchema.methods.getSuccessRate = function () {
  if (this.totalRequests === 0) return 100;
  return (this.successfulRequests / this.totalRequests) * 100;
};

// Static methods
instagramAccountSchema.statics.getAvailableAccount = async function (
  excludeIds = [],
) {
  const now = new Date();

  // Find available accounts, prioritizing by:
  // 1. Not recently used (least recently used first)
  // 2. Higher priority
  // 3. Better success rate
  const account = await this.findOne({
    _id: { $nin: excludeIds },
    isAvailable: true,
    status: "active",
    $or: [{ rateLimitUntil: null }, { rateLimitUntil: { $lt: now } }],
  })
    .sort({ lastUsedAt: 1, priority: -1 })
    .exec();

  // Check and update rate limit status if expired
  if (account) {
    account.checkRateLimitExpired();
    if (!account.isAvailable) {
      await account.save();
      // Recursively find next available account
      return this.getAvailableAccount([...excludeIds, account._id]);
    }
  }

  return account;
};

instagramAccountSchema.statics.getAccountStats = async function (
  userId = null,
) {
  const query = userId ? { userId } : {};

  const accounts = await this.find(query);

  return {
    total: accounts.length,
    active: accounts.filter((a) => a.status === "active").length,
    available: accounts.filter((a) => a.isAvailable).length,
    rateLimited: accounts.filter((a) => a.status === "rate_limited").length,
    suspended: accounts.filter((a) => a.status === "suspended").length,
    error: accounts.filter((a) => a.status === "error").length,
    avgSuccessRate:
      accounts.reduce((sum, a) => sum + a.getSuccessRate(), 0) /
      (accounts.length || 1),
    totalRequests: accounts.reduce((sum, a) => sum + a.totalRequests, 0),
  };
};

const InstagramAccount =
  mongoose.models.InstagramAccount ||
  mongoose.model("InstagramAccount", instagramAccountSchema);

export default InstagramAccount;
