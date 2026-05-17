import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    first_name: {
      type: String,
      required: [true, "First name is required"],
      trim: true,
      maxlength: [255, "First name cannot be more than 255 characters"],
    },
    last_name: {
      type: String,
      trim: true,
      maxlength: [255, "Last name cannot be more than 255 characters"],
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      trim: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, "Please enter a valid email address"],
    },
    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: [6, "Password must be at least 6 characters long"],
      select: false, // Don't return password by default
    },
    role: {
      type: String,
      required: [true, "Role is required"],
      enum: {
        values: ["USER", "ADMIN"],
        message: "Role must be either USER, ADMIN",
      },
      default: "USER",
    },
    otp: {
      type: String,
      maxlength: 10,
      default: null,
    },

    otp_expiry: {
      type: Date,
      default: null,
    },

    avatar_url: {
      type: String,
      default: null,
    },

    avatar_url_id: {
      type: String,
      default: null,
    },

    is_verified: {
      type: Boolean,
      default: false,
    },

    reset_otp: {
      type: String,
      maxlength: 6,
      default: null,
    },

    reset_otp_expiry: {
      type: Date,
      default: null,
    },
    auth_provider: {
      type: String,
      default: "local",
      enum: ["local", "google", "facebook", "github"], // optional
    },
    is_notifications_enabled: {
      type: Boolean,
      default: true,
    },
    is_update_enabled: {
      type: Boolean,
      default: true,
    },
    is_feedback_completed: {
      type: Boolean,
      default: false,
    },
    is_deleted: {
      type: Boolean,
      default: false,
    },
    is_blocked: {
      type: Boolean,
      default: false,
    },
    is_onboarding_completed: {
      type: Boolean,
      default: false,
    },
    stripe_customer_id: {
      type: String,
      default: null,
      sparse: true,
      index: true,
    },
    business_website: {
      type: String,
      default: null,
    },
    business_name: {
      type: String,
      default: null,
    },
    business_website_url: {
      type: String,
      default: null,
    }, 
    heard_about: {
      type: String,
      default: null,
      enum: ["mouth/word", "instagram", "linkedin", "facebook", "github"],
    },
  },
  {
    timestamps: {
      createdAt: "created_at",
      updatedAt: "updated_at", // Add updated_at field
    },
  },
);

// Indexes
userSchema.index({ email: 1 });

const User = mongoose.model("User", userSchema);

export default User;
