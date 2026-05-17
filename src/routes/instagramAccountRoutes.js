import express from "express";
import {
  addAccount,
  getAccounts,
  getAccount,
  updateAccount,
  updateCookies,
  deleteAccount,
  testAccount,
  getPoolStats,
  performHealthCheck,
  resetFailures,
} from "../controllers/instagramAccountController.js";
import auth from "../middlewares/auth.js";
import { body, param } from "express-validator";
import validate from "../middlewares/validate.js";

const router = express.Router();

// All routes require authentication (user role)
router.use(auth(["user"]));

// Validation schemas
const addAccountValidation = [
  body("username").trim().notEmpty().withMessage("Username is required"),
  body("instagramUserId")
    .trim()
    .notEmpty()
    .withMessage("Instagram User ID is required"),
  body("cookies")
    .isArray({ min: 1 })
    .withMessage("Cookies must be a non-empty array"),
  body("priority")
    .optional()
    .isInt({ min: 0, max: 10 })
    .withMessage("Priority must be between 0-10"),
  validate,
];

const updateAccountValidation = [
  param("id").isMongoId().withMessage("Invalid account ID"),
  body("displayName").optional().trim(),
  body("priority")
    .optional()
    .isInt({ min: 0, max: 10 })
    .withMessage("Priority must be between 0-10"),
  body("status")
    .optional()
    .isIn(["active", "inactive", "rate_limited", "suspended", "error"]),
  body("isAvailable").optional().isBoolean(),
  validate,
];

const updateCookiesValidation = [
  param("id").isMongoId().withMessage("Invalid account ID"),
  body("cookies")
    .isArray({ min: 1 })
    .withMessage("Cookies must be a non-empty array"),
  validate,
];

const idParamValidation = [
  param("id").isMongoId().withMessage("Invalid account ID"),
  validate,
];

// Routes
router.post("/accounts", addAccountValidation, addAccount);
router.get("/accounts", getAccounts);
router.get("/accounts/stats", getPoolStats);
router.get("/accounts/health-check", performHealthCheck);
router.get("/accounts/:id", idParamValidation, getAccount);
router.patch("/accounts/:id", updateAccountValidation, updateAccount);
router.put("/accounts/:id/cookies", updateCookiesValidation, updateCookies);
router.post("/accounts/:id/test", idParamValidation, testAccount);
router.post("/accounts/:id/reset-failures", idParamValidation, resetFailures);
router.delete("/accounts/:id", idParamValidation, deleteAccount);

export default router;
