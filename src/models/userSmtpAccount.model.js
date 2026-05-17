import mongoose from "mongoose";
import crypto from "crypto";

// IMPORTANT: CRYPTO_SECRET_KEY should be set in environment variables for stable encryption
if (!process.env.CRYPTO_SECRET_KEY) {
  console.warn(
    "\n⚠️  WARNING: CRYPTO_SECRET_KEY is not set in environment variables!\n" +
      "   This will cause SMTP password decryption to fail after server restarts.\n" +
      "   Generate a key with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"\n" +
      "   Then add it to your .env file.\n",
  );
}

const ENCRYPTION_KEY =
  process.env.CRYPTO_SECRET_KEY || crypto.randomBytes(32).toString("hex");
const ALGORITHM = "aes-256-gcm";

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
    console.error("SMTP credential decryption error:", error.message);
    return null;
  }
};

const userSmtpAccountSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    label: {
      type: String,
      trim: true,
      default: null,
    },
    sender_name: {
      type: String,
      trim: true,
      default: null,
    },
    email_address: {
      type: String,
      required: [true, "Email address is required"],
      trim: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, "Please enter a valid email address"],
    },
    username: {
      type: String,
      required: [true, "SMTP username is required"],
      trim: true,
    },
    smtp: {
      host: {
        type: String,
        required: [true, "SMTP host is required"],
        trim: true,
      },
      port: {
        type: Number,
        required: [true, "SMTP port is required"],
      },
      secure: {
        type: Boolean,
        default: true,
      },
      auth: {
        encryptedPassword: {
          encrypted: { type: String, required: true },
          iv: { type: String, required: true },
          authTag: { type: String, required: true },
        },
      },
    },
    imap: {
      enabled: {
        type: Boolean,
        default: false,
      },
      host: {
        type: String,
        trim: true,
        default: null,
      },
      port: {
        type: Number,
        default: null,
      },
      secure: {
        type: Boolean,
        default: true,
      },
    },
    settings: {
      enable_inbox: {
        type: Boolean,
        default: false,
      },
      warmup_enabled: {
        type: Boolean,
        default: false,
      },
      messages_per_day: {
        type: Number,
        default: 25,
        min: 1,
      },
      signature: {
        type: String,
        trim: true,
        default: null,
      },
      unsubscribe_url: {
        type: String,
        trim: true,
        default: null,
      },
      is_default: {
        type: Boolean,
        default: false,
      },
      active: {
        type: Boolean,
        default: true,
      },
    },
    status: {
      type: String,
      enum: ["active", "inactive", "error", "disabled"],
      default: "active",
      index: true,
    },
    is_verified: {
      type: Boolean,
      default: false,
    },
    is_tested: {
      type: Boolean,
      default: false,
    },
    messages_sent_today: {
      type: Number,
      default: 0,
    },
    day_window_start: {
      type: Date,
      default: () => new Date(),
    },
    last_sent_at: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (doc, ret) => {
        if (ret.smtp?.auth) {
          delete ret.smtp.auth;
        }
        delete ret.__v;
        return ret;
      },
    },
  },
);

userSmtpAccountSchema.index({ user_id: 1, email_address: 1 }, { unique: true });
userSmtpAccountSchema.index({ user_id: 1, status: 1 });
userSmtpAccountSchema.index({ "settings.active": 1, "settings.is_default": 1 });

userSmtpAccountSchema.methods.setPassword = function (password) {
  this.smtp.auth = { encryptedPassword: encrypt(password) };
};

userSmtpAccountSchema.methods.getPassword = function () {
  return decrypt(this.smtp.auth.encryptedPassword);
};

userSmtpAccountSchema.methods.getTransportConfig = function () {
  const password = this.getPassword();
  if (!password) return null;
  return {
    host: this.smtp.host,
    port: this.smtp.port,
    secure: this.smtp.secure,
    auth: {
      user: this.username,
      pass: password,
    },
    requireTLS: !this.smtp.secure,
    tls: {
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
    },
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
  };
};

export default mongoose.model("UserSmtpAccount", userSmtpAccountSchema);
