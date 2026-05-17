import express from "express";
import { param, body } from "express-validator";
import auth from "../middlewares/auth.js";
import validate from "../middlewares/validate.js";
import {
  adminGetAllAccounts,
  adminAddAccount,
  adminUpdateAccount,
  adminUpdateCookies,
  adminDeleteAccount,
  adminResetAccount,
} from "../controllers/adminAccountPoolController.js";

const router = express.Router();

// All routes require admin role
router.use(auth(["admin"]));

const idValidation = [
  param("id").isMongoId().withMessage("Invalid account ID"),
  validate,
];

const addAccountValidation = [
  body("cookies").notEmpty().withMessage("cookies field is required"),
  body("displayName").optional().trim(),
  body("notes").optional().trim(),
  validate,
];

const updateAccountValidation = [
  param("id").isMongoId().withMessage("Invalid account ID"),
  body("displayName").optional().trim(),
  body("priority").optional().isInt({ min: 0, max: 10 }),
  body("status").optional().isIn(["active", "inactive", "rate_limited", "suspended", "error"]),
  body("isAvailable").optional().isBoolean(),
  validate,
];

const updateCookiesValidation = [
  param("id").isMongoId().withMessage("Invalid account ID"),
  body("cookies").notEmpty().withMessage("cookies field is required"),
  validate,
];

router.get("/", adminGetAllAccounts);
router.post("/", addAccountValidation, adminAddAccount);
router.patch("/:id", updateAccountValidation, adminUpdateAccount);
router.put("/:id/cookies", updateCookiesValidation, adminUpdateCookies);
router.post("/:id/reset", idValidation, adminResetAccount);
router.delete("/:id", idValidation, adminDeleteAccount);

export default router;
