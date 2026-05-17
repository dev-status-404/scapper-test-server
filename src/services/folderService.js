import Folder from "../models/folder.model.js";

const createFolder = async (payload) => {
  try {
    const folder = await Folder.create(payload);
    return {
      code: 201,
      success: true,
      message: "Folder created successfully",
      data: folder,
    };
  } catch (error) {
    throw error;
  }
};

const getFolder = async (filters = {}) => {
  try {
    const { user_id, id, name, page = 1, limit = 10 } = filters;
    const query = { is_deleted: false };

    if (name) {
      query.name = { $regex: name, $options: "i" };
    }

    if (user_id) {
      query.user_id = user_id;
    }

    if (id) {
      query._id = id;
    }

    const skip = (page - 1) * limit;

    const [folders, total] = await Promise.all([
      Folder.find(query).skip(skip).limit(parseInt(limit)).lean(),
      Folder.countDocuments(query),
    ]);

    return {
      code: 200,
      success: true,
      message: "Folders retrieved successfully",
      data: folders,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / limit),
      },
    };
  } catch (error) {
    throw error;
  }
};

const updateFolder = async (payload) => {
  try {
    if (!payload.folder_id) {
      return {
        code: 400,
        success: false,
        message: "Folder ID is required",
      };
    }
    const folder = await Folder.findOneAndUpdate(
      { _id: payload.folder_id, is_deleted: false },
      { name: payload.name },
    );
    return {
      code: 201,
      success: true,
      message: "Folder updated successfully",
      data: folder,
    };
  } catch (error) {
    throw error;
  }
};

const deleteFolder = async (filters = {}) => {
  try {
    const { folder_id } = filters;
    if (!folder_id) {
      return {
        code: 400,
        success: false,
        message: "Folder ID is required",
      };
    }
    const folder = await Folder.findOneAndUpdate(
      { _id: folder_id },
      { is_deleted: true },
    );

    return {
      code: 200,
      success: true,
      message: "Folder deleted successfully",
      data: folder,
    };
  } catch (error) {
    throw error;
  }
};

const bulkDeleteFolder = async (filters = {}) => {
  try {
    const { folder_ids } = filters;
    if (!folder_ids) {
      return {
        code: 400,
        success: false,
        message: "Folder IDs are required",
      };
    }
    const folders = await Folder.updateMany(
      { _id: { $in: folder_ids } },
      { is_deleted: true },
      { new: true },
    );

    return {
      code: 200,
      success: true,
      message: "Folders deleted successfully",
      data: folders,
    };
  } catch (error) {
    throw error;
  }
};

export const folderService = {
  createFolder,
  getFolder,
  updateFolder,
  deleteFolder,
  bulkDeleteFolder,
};
