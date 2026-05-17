import EmailTemplate from "../models/emailTemplate.model.js";

const TRACKING_PIXEL_MARKER = "<!--TRACKING_PIXEL-->";

const ensureTrackingPixelMarker = (content) => {
  if (typeof content !== "string" || !content.trim()) return content;
  if (
    content.includes(TRACKING_PIXEL_MARKER) ||
    content.includes("/api/campaign/track/")
  ) {
    return content;
  }

  if (/<\/body>/i.test(content)) {
    return content.replace(/<\/body>/i, `${TRACKING_PIXEL_MARKER}</body>`);
  }

  return `${content}${TRACKING_PIXEL_MARKER}`;
};

const withTrackingMarker = (payload) => {
  if (!Object.prototype.hasOwnProperty.call(payload, "content")) {
    return payload;
  }

  return {
    ...payload,
    content: ensureTrackingPixelMarker(payload.content),
  };
};

const createTemplate = async (payload) => {
  try {
    if (!payload.user_id) {
      return { code: 400, success: false, message: "user-id-required" };
    }

    payload = withTrackingMarker(payload);

    const template = await EmailTemplate.create(payload);
    return {
      code: 201,
      success: true,
      message: "template-created-successfully",
      data: template,
    };
  } catch (error) {
    throw error;
  }
};

const getTemplates = async (userId, filters = {}) => {
  try {
    if (!userId) {
      return { code: 400, success: false, message: "user-id-required" };
    }

    const {
      page = 1,
      limit = 20,
      category,
      search,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = filters;

    const query = { user_id: userId, is_deleted: false };
    if (category) query.category = category;
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
      ];
    }

    const sortOptions = { [sortBy]: sortOrder === "desc" ? -1 : 1 };

    const [templates, total] = await Promise.all([
      EmailTemplate.find(query)
        .sort(sortOptions)
        .limit(Number(limit))
        .skip((Number(page) - 1) * Number(limit)),
      EmailTemplate.countDocuments(query),
    ]);

    return {
      code: 200,
      success: true,
      message: "templates-retrieved-successfully",
      data: templates,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    };
  } catch (error) {
    throw error;
  }
};

const getTemplateById = async (templateId, userId) => {
  try {
    if (!templateId || !userId) {
      return {
        code: 400,
        success: false,
        message: "template-id-and-user-id-required",
      };
    }

    const template = await EmailTemplate.findOne({
      _id: templateId,
      user_id: userId,
      is_deleted: false,
    });

    if (!template) {
      return { code: 404, success: false, message: "template-not-found" };
    }

    return {
      code: 200,
      success: true,
      message: "template-retrieved-successfully",
      data: template,
    };
  } catch (error) {
    throw error;
  }
};

const updateTemplate = async (templateId, userId, payload) => {
  try {
    if (!templateId || !userId) {
      return {
        code: 400,
        success: false,
        message: "template-id-and-user-id-required",
      };
    }

    payload = withTrackingMarker(payload);

    const template = await EmailTemplate.findOneAndUpdate(
      { _id: templateId, user_id: userId, is_deleted: false },
      payload,
      { new: true, runValidators: true },
    );

    if (!template) {
      return {
        code: 404,
        success: false,
        message: "template-not-found-or-cannot-be-updated",
      };
    }

    return {
      code: 200,
      success: true,
      message: "template-updated-successfully",
      data: template,
    };
  } catch (error) {
    throw error;
  }
};

const deleteTemplate = async (templateId, userId) => {
  try {
    if (!templateId || !userId) {
      return {
        code: 400,
        success: false,
        message: "template-id-and-user-id-required",
      };
    }

    const template = await EmailTemplate.findOneAndUpdate(
      { _id: templateId, user_id: userId, is_deleted: false },
      { is_deleted: true },
      { new: true },
    );

    if (!template) {
      return { code: 404, success: false, message: "template-not-found" };
    }

    return {
      code: 200,
      success: true,
      message: "template-deleted-successfully",
    };
  } catch (error) {
    throw error;
  }
};

export const emailTemplateService = {
  createTemplate,
  getTemplates,
  getTemplateById,
  updateTemplate,
  deleteTemplate,
};
