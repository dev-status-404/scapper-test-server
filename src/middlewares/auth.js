import httpStatus from "http-status";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../config/env.js";
import ApiError from "../utils/ApiError.js";
import User from "../models/user.model.js";
// import Admin from "../models/admin.model.js";

/**
 * Middleware for role-based authentication and authorization
 * @param {Array} allowedRoles - Array of roles that are allowed to access the route
 * @param {Object} options - Additional options
 * @param {Array} options.userAllowedMethods - Array of HTTP methods that users are allowed to access (only applicable if role is 'user')
 * @returns {Function} Express middleware function
 */
const auth = (allowedRoles = [], options = {}) => {
  const { userAllowedMethods = [] } = options;
  return async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;
      const headerToken =
        authHeader && authHeader.startsWith("Bearer ")
          ? authHeader.split(" ")[1]
          : null;

      const cookieToken = req.cookies?.accessToken;

      const token = headerToken || cookieToken;

      if (!token) {
        return res
          .status(401)
          .json({ success: false, message: "No token provided" });
      }

      if (!token) {
        return res.status(httpStatus.UNAUTHORIZED).json({
          code: httpStatus.UNAUTHORIZED,
          success: false,
          message: "Authentication token is required",
          data: null,
        });
      }

      // Verify token
      const decoded = jwt.verify(token, JWT_SECRET);
      if (!decoded?.sub) {
        throw new ApiError(httpStatus.UNAUTHORIZED, "Invalid token payload");
      }

      // Look up user (admin first, then user)

      // if (!user) {
      let user = await User.findById(decoded.sub);
      
      if (!user) {
        throw new ApiError(httpStatus.UNAUTHORIZED, "User not found");
      }

      const isAdmin = user?.role === "ADMIN";
      
      // Authorization checks
      if (allowedRoles.length && !isAdmin) {
        const userRole = user.role || "USER";

        if (!allowedRoles.includes(userRole)) {
          throw new ApiError(httpStatus.FORBIDDEN, "Insufficient permissions");
        }

        if (
          userAllowedMethods.length &&
          !userAllowedMethods.includes(req.method)
        ) {
          throw new ApiError(
            httpStatus.FORBIDDEN,
            "This HTTP method is not allowed for your role",
          );
        }
      }

      // Attach user info to request
      req.user = user;
      req.isAdmin = isAdmin;

      return next();
    } catch (error) {
      if (error.name === "TokenExpiredError") {
        return next(new ApiError(httpStatus.UNAUTHORIZED, "Token expired"));
      }
      if (error.name === "JsonWebTokenError") {
        return next(new ApiError(httpStatus.UNAUTHORIZED, "Invalid token"));
      }
      return next(error);
    }
  };
};

export default auth;
