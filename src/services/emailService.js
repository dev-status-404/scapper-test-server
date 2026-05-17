import Email from "../models/email.model.js"
import { generateOTP } from "./authService.js"
import { sendVerificationEmail } from "../utils/email.js"

const addEmail = async (payload) => {
    try {
        if (!payload.user_id) {
            return {
                code: 400,
                success: false,
                message: 'User ID is required',
            }
        }

        // Generate OTP
        const otp = generateOTP();
         
        const email = await Email.create({
            ...payload,
            otp,
        })

        console.log("Email added successfully", email);
        // 4️⃣ Send verification email with OTP
        sendVerificationEmail(email.email, otp);

        return {
            code: 201,
            success: true,
            message: 'Email added successfully',
            data: email,
        }
    } catch (error) {
        throw error
    }
}

const verifyEmail = async (payload) => {
    try {
        if (!payload.email) {
            return {
                code: 400,
                success: false,
                message: 'Email is required',
            }
        }

        const email = await Email.findOne({ email: payload.email });
        if (!email) {
            return {
                code: 401,
                success: false,
                message: "email-not-found",
            };
        }

        console.log("email", email.otp);
        console.log("payload", payload.otp);
        // 🔐 Compare OTP
        const match = payload.otp === email.otp;
        if (!match) {
            return {
                code: 401,
                success: false,
                message: "invalid-otp",
            };
        }

        // ✅ OTP verified successfully — update user
        await Email.findOneAndUpdate(
            { email: payload.email },
            {
                verified: true,
                otp: null,
            },
        );
        return {
            code: 200,
            success: true,
            message: 'Email-verified-successfully',
            data: email,
        }
    } catch (error) {
        throw error
    }
}

const getEmail = async (filter) => {
    try {
        if (!filter.user_id) {
            return {
                code: 400,
                success: false,
                message: 'User ID is required',
            }
        }

        const email = await Email.find({ user_id: filter.user_id, verified: true });

        return {
            code: 200,
            success: true,
            message: 'Email retrieved successfully',
            data: email,
        }
    } catch (error) {
        throw error
    }
}

const deleteEmail = async (filters = {}) => {
    try {
        const { email_id } = filters;

        if (!email_id) {
            return {
                code: 400,
                success: false,
                message: 'email_id-is-required',
            }
        }

        const email = await Email.findOneAndDelete({ _id: email_id });

        if (!email) {
            return {
                code: 404,
                success: false,
                message: 'email-not-found',
            }
        }

        return {
            code: 200,
            success: true,
            message: 'deleted-successfully',
            data: email,
        }
    } catch (error) {
        throw error
    }
}

const bulkDeleteEmail = async (filters = {}) => {
    try {
        const { email_ids } = filters;

        if (!Array.isArray(email_ids) || email_ids.length === 0) {
            return {
                code: 400,
                success: false,
                message: 'email_ids-is-required',
            }
        }

        const result = await Email.deleteMany({ _id: { $in: email_ids } });

        return {
            code: 200,
            success: true,
            message: 'deleted-successfully',
            data: {
                deletedCount: result.deletedCount,
            },
        }
    } catch (error) {
        throw error
    }
}

export const emailService = {
    addEmail,
    verifyEmail,
    getEmail,
    deleteEmail,
    bulkDeleteEmail,
}