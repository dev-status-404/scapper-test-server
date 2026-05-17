export function sendError(res, error, fallbackStatus = 400) {
  const status =
    error?.status ||
    error?.statusCode ||
    error?.response?.status ||
    fallbackStatus;

  return res.status(status).json({
    code: status,
    success: false,
    message: error?.message || "Request failed",
    jwt: null,
    data: null,
    redirect: null,
  });
}