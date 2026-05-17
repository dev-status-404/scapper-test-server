import InstagramService from "../services/instaService.js";
import { sendError } from "../utils/errorHelper.js";

const scrapeProfile = async (req, res) => {
  try {
    const response = await InstagramService.scrapeInstagramProfile(req.body);
    return res.status(response.code).json({
      code: response.code,
      success: response.success,
      message: response.message,
      data: response.data,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const InstaController = {
  scrapeProfile,
};