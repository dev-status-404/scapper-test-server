import { leadService } from "../services/leadService.js";

const createLead = async (req, res) => {
  try {
    const response = await leadService.createLead(req.body);
    return res.status(response.code).json({
      code: response.code,
      success: response.success,
      message: response.message,
      data: response.data,
    });
  } catch (error) {
    return res.status(error.code || 500).json({
      code: error.code || 500,
      success: false,
      message: error.message,
      error: error,
    });
  }
};
const downloadAllLeads = async (req, res, next) => {
  try {
    const result = await leadService.downloadAllLeads(req.query);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${result.filename}"`,
    );

    return res.status(200).send(result.csv);
  } catch (err) {
    next(err);
  }
};

const getLead = async (req, res) => {
  try {
    const response = await leadService.getLead(req.query);
    return res.status(response.code).json({
      code: response.code,
      success: response.success,
      message: response.message,
      data: response.data,
      pagination: response.pagination,
    });
  } catch (error) {
    return res.status(error.code || 500).json({
      code: error.code || 500,
      success: false,
      message: error.message,
      error: error,
    });
  }
};

const updateLead = async (req, res) => {
  try {
    const response = await leadService.updateLead(req.body);
    return res.status(response.code).json({
      code: response.code,
      success: response.success,
      message: response.message,
      data: response.data,
    });
  } catch (error) {
    return res.status(error.code || 500).json({
      code: error.code || 500,
      success: false,
      message: error.message,
      error: error,
    });
  }
};

const deleteLead = async (req, res) => {
  try {
    const response = await leadService.deleteLead(req.query);
    return res.status(response.code).json({
      code: response.code,
      success: response.success,
      message: response.message,
      data: response.data,
    });
  } catch (error) {
    return res.status(error.code || 500).json({
      code: error.code || 500,
      success: false,
      message: error.message,
      error: error,
    });
  }
};

const bulkDeleteLead = async (req, res) => {
  try {
    const response = await leadService.bulkDeleteLead(req.body);
    return res.status(response.code).json({
      code: response.code,
      success: response.success,
      message: response.message,
      data: response.data,
    });
  } catch (error) {
    return res.status(error.code || 500).json({
      code: error.code || 500,
      success: false,
      message: error.message,
      error: error,
    });
  }
};

const getLeadSummary = async (req, res) => {
  try {
    const response = await leadService.getLeadSummary(req.query);
    return res.status(response.code).json({
      code: response.code,
      success: response.success,
      message: response.message,
      data: response.data,
    });
  } catch (error) {
    return res.status(error.code || 500).json({
      code: error.code || 500,
      success: false,
      message: error.message,
      error: error,
    });
  }
};

const bulkUploadLeads = async (req, res) => {
  const { folder_id, leads, user_id } = req.body;
  try {
    const result = await leadService.uploadBulkLeads({
      folder_id,
      user_id,
      leads,
    });
    return res.status(result.code).json({
      code: result.code,
      success: result.success,
      message: result.message,
      data: result.data,
    });
  } catch (error) {
    return res.status(error.code || 500).json({
      code: error.code || 500,
      success: false,
      message: error.message,
      error: error,
    });
  }
};

const updateBulkScrappedLeads = async (req, res) => {
  try {
    const response = await leadService.updateBulkScrappedLeads(req.body);
    return res.status(response.code).json({
      code: response.code,
      success: response.success,
      message: response.message,
      data: response.data,
    });
  } catch (error) {
    return res.status(error.code || 500).json({
      code: error.code || 500,
      success: false,
      message: error.message,
      error: error,
    });
  }
};

const getLeadScrapeStats = async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) {
      return res.status(400).json({ code: 400, success: false, message: "user_id-required" });
    }
    const data = await leadService.getUserLeadStats(user_id);
    return res.status(200).json({ code: 200, success: true, message: "fetched-successfully", data });
  } catch (error) {
    return res.status(error.code || 500).json({
      code: error.code || 500,
      success: false,
      message: error.message,
    });
  }
};

export const leadController = {
  createLead,
  getLead,
  updateLead,
  deleteLead,
  bulkDeleteLead,
  getLeadSummary,
  downloadAllLeads,
  bulkUploadLeads,
  updateBulkScrappedLeads,
  getLeadScrapeStats,
};
