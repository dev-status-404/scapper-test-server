
import { folderService } from '../services/folderService.js';

const createFolder = async (req, res) => {
    try {
        const response = await folderService.createFolder(req.body);
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
                message: error.message,
                error: error,
            }
        );
    }
};

const getFolder = async (req, res) => {
    try {
        const response = await folderService.getFolder(req.query);
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
                message: error.message,
                error: error,
            }
        );
    }
}

const updateFolder = async (req, res) => {
    console.log(req.body)
    try {
        const response = await folderService.updateFolder(req.body);
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
                message: error.message,
                error: error,
            }
        );
    }
}

const deleteFolder = async (req, res) => {
    try {
        const response = await folderService.deleteFolder(req.params);
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
                message: error.message,
                error: error,
            }
        );
    }
}

const bulkDelete = async (req, res) => {
     try {
        const response = await folderService.bulkDeleteFolder(req.body);
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
                message: error.message,
                error: error,
            }
        );
    }
}

export const folderController = {
    createFolder,
    getFolder,
    updateFolder,
    deleteFolder,
    bulkDelete
}