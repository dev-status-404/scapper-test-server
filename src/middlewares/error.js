import httpStatus from "http-status";
import logger from "../utils/logger.js";
import ApiError from "../utils/ApiError.js";
import { bindErrorContext, captureException } from "../monitoring/index.js";

const safeError = (err) => ({
  code: err.code || err.statusCode || 500,
  success: false,
  message: err.message || "Internal Server Error",
  error: process.env.NODE_ENV === "development" ? err : undefined,
});

const errorConverter = (err, req, res, next) => {
  let error = err;

  if (!(error instanceof ApiError)) {
    const statusCode = error.statusCode || httpStatus.INTERNAL_SERVER_ERROR;
    const message = error.message || httpStatus[statusCode];
    error = new ApiError(statusCode, message, false, err.stack);
  }

  next(error);
};

const errorHandler = (err, req, res, next) => {
  const { statusCode, message } = err;

  const response = {
    code: statusCode,
    message,
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  };

  const errorContext = bindErrorContext({
    req,
    tags: {
      status_code: statusCode,
      is_operational: err.isOperational ?? true,
    },
    extra: {
      status_code: statusCode,
    },
  });

  if (statusCode >= 500 || err.isOperational === false) {
    logger.error(
      {
        err,
        request_id: req?.requestId,
        method: req?.method,
        path: req?.originalUrl,
        status_code: statusCode,
        user_id: req?.user?._id?.toString?.() || null,
      },
      "request failed",
    );
    captureException(err, errorContext);
  } else if (process.env.NODE_ENV === "development") {
    logger.warn(
      {
        err,
        request_id: req?.requestId,
        method: req?.method,
        path: req?.originalUrl,
        status_code: statusCode,
      },
      "request rejected",
    );
  }

  res.status(statusCode).json(response);
};

export { errorConverter, errorHandler, safeError };
