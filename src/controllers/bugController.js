import { bugService } from '../services/bugService.js';

const createBug = async (req, res) => {
    try {
        const response = await bugService.createBug(req.body);
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

const getBug = async (req, res) => {
    try {
        const response = await bugService.getBug(req.query);
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

const updateBug = async (req, res) => {
    try {
        const response = await bugService.updateBug(req.body);
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

const deleteBug = async (req, res) => {
    try {
        const response = await bugService.deleteBug({ bug_id: req.params.id });
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

export const bugController = {
    createBug,
    getBug,
    updateBug,
    deleteBug,
}