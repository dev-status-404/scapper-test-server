import { safeError } from "../middlewares/error.js";
import { dashboardService } from "../services/dashboardService.js";
import { sendError } from "../utils/errorHelper.js";

export const getDashboard = async (req, res, next) => {
  try {
    // or however you attach user
    const { days, dateFrom, dateTo, user_id } = req.query;

    const filters = {
      days,
      dateFrom,
      dateTo,
      user_id,
    };

    const data = await dashboardService.getDashboardData(filters);

    return res.status(200).json(data);
  } catch (e) {
    safeError(e);
  }
};

export const dashboardController = {
  getDashboard,
};
