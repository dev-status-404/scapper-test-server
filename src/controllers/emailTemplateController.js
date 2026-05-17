import { emailTemplateService } from "../services/emailTemplateService.js";

const createTemplate = async (req, res) => {
  try {
    const response = await emailTemplateService.createTemplate(req.body);
    return res.status(response.code).json(response);
  } catch (error) {
    return res
      .status(error.code || 500)
      .json({ code: error.code || 500, success: false, message: error.message || "something-went-wrong" });
  }
};

const getTemplates = async (req, res) => {
  try {
    const response = await emailTemplateService.getTemplates(
      req.query.user_id,
      req.query,
    );
    return res.status(response.code).json(response);
  } catch (error) {
    return res
      .status(error.code || 500)
      .json({ code: error.code || 500, success: false, message: error.message || "something-went-wrong" });
  }
};

const getTemplateById = async (req, res) => {
  try {
    const response = await emailTemplateService.getTemplateById(
      req.query.template_id,
      req.query.user_id,
    );
    return res.status(response.code).json(response);
  } catch (error) {
    return res
      .status(error.code || 500)
      .json({ code: error.code || 500, success: false, message: error.message || "something-went-wrong" });
  }
};

const updateTemplate = async (req, res) => {
  try {
    const response = await emailTemplateService.updateTemplate(
      req.body.template_id,
      req.body.user_id,
      req.body,
    );
    return res.status(response.code).json(response);
  } catch (error) {
    return res
      .status(error.code || 500)
      .json({ code: error.code || 500, success: false, message: error.message || "something-went-wrong" });
  }
};

const deleteTemplate = async (req, res) => {
  try {
    const response = await emailTemplateService.deleteTemplate(
      req.query.template_id,
      req.query.user_id,
    );
    return res.status(response.code).json(response);
  } catch (error) {
    return res
      .status(error.code || 500)
      .json({ code: error.code || 500, success: false, message: error.message || "something-went-wrong" });
  }
};

export const emailTemplateController = {
  createTemplate,
  getTemplates,
  getTemplateById,
  updateTemplate,
  deleteTemplate,
};
