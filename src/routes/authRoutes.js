import express from "express";
const router = express.Router();
import { authController } from "../controllers/authController.js";
import { userController } from "../controllers/userController.js";
import auth from "../middlewares/auth.js";

// Authentication routes
router.post("/register", authController.register);
router.post("/login", authController.login);
router.post("/verify-otp", authController.verifyOTP);
router.post("/resend-otp", authController.resendOTP);
router.post("/send-password-reset-otp", authController.sendPasswordResetOTP);
router.post("/reset-password-with-otp", authController.resetPasswordWithOTP);
router.get(
  "/verification",
  auth(["ADMIN", "USER"]),
  authController.verifyUserJWT,
);
router.post("/preference", authController.updateUserPreference);
router.get("/get-user", userController.getUsers);
router.post("/google-signin", authController.googleLogin);

export default router;
