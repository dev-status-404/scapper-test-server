import { emailService } from '../services/emailService.js';

const addEmail = async (req, res) => {
    try {
        const response = await emailService.addEmail(req.body);
        return res.status(response.code).json(
            {
                code: response.code,
                success: response.success,
                message: response.message,
                data: response.data,
            }
        );
    } catch (error) {
        return res.status(error.code || 500).json(
            {
                code: error.code || 500,
                success: false,
                message: error.message || "Something went wrong",
            }
        );
    }
};

const verifyEmail = async (req, res) => {
    try {
        const response = await emailService.verifyEmail(req.body);
        return res.status(response.code).json(
            {
                code: response.code,
                success: response.success,
                message: response.message,
                data: response.data,
            }
        );
    } catch (error) {
        return res.status(error.code || 500).json(
            {
                code: error.code || 500,
                success: false,
                message: error.message || "Something went wrong",
            }
        );
    }
};

const getEmail = async (req, res) => {
    try {
        const response = await emailService.getEmail(req.query);
        return res.status(response.code).json(
            {
                code: response.code,
                success: response.success,
                message: response.message,
                data: response.data,
            }
        );
    } catch (error) {
        return res.status(error.code || 500).json(
            {
                code: error.code || 500,
                success: false,
                message: error.message || "Something went wrong",
            }
        );
    }
};

const deleteEmail = async (req, res) => {
    try {
        const response = await emailService.deleteEmail(req.query);
        return res.status(response.code).json(
            {
                code: response.code,
                success: response.success,
                message: response.message,
                data: response.data,
            }
        );
    } catch (error) {
        return res.status(error.code || 500).json(
            {
                code: error.code || 500,
                success: false,
                message: error.message || "Something went wrong",
            }
        );
    }
};

const bulkDeleteEmail = async (req, res) => {
    try {
        const response = await emailService.bulkDeleteEmail(req.body);
        return res.status(response.code).json(
            {
                code: response.code,
                success: response.success,
                message: response.message,
                data: response.data,
            }
        );
    } catch (error) {
        return res.status(error.code || 500).json(
            {
                code: error.code || 500,
                success: false,
                message: error.message || "Something went wrong",
            }
        );
    }
};

export const emailController = {
    addEmail,
    verifyEmail,
    getEmail,
    deleteEmail,
    bulkDeleteEmail,
}