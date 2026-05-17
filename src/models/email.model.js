import mongoose from "mongoose";

const EmailSchema = new mongoose.Schema(
    {
        user_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },
        email: {
            type: String,
            required: true,
        },
        verified: {
            type: Boolean,
            default: false,
        },
        otp: {
            type: String,
            maxlength: 10,
            default: null,
        },
    },
    {
        timestamps: true,
    }
);

// Compound index for efficient lookups
EmailSchema.index({ user_id: 1, email: 1 });

export default mongoose.model("Email", EmailSchema);
