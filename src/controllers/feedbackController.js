import { feedbackService } from '../services/feedbackService.js';

const createFeedback = async (req, res) => {
    try {
        const response = await feedbackService.createFeedback(req.body);
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

const getFeedback = async (req, res) => {
    try {
        const response = await feedbackService.getFeedback(req.query);
        return res.status(response.code).json(
            {
                code: response.code,
                success: response.success,
                message: response.message,
                data: response.data,
                pagination: response.pagination,
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
}

const updateFeedback = async (req, res) => {
    try {
        const response = await feedbackService.updateFeedback(req.body);
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
}

const deleteFeedback = async (req, res) => {
    try {
        const response = await feedbackService.deleteFeedback(req.query);
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
}

export const feedbackController = {
    createFeedback,
    getFeedback,
    updateFeedback,
    deleteFeedback,
}