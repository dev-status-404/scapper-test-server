import express from "express";
import { userController } from "../controllers/userController.js";
import { uploadStoreLogo, uploadImage, uploadAvatarImage } from "../middlewares/fileUpload.js";
import auth from "../middlewares/auth.js";
const router = express.Router();

// User routes
router.put("/me", auth(['ADMIN','USER']), uploadImage, userController.updateUser);
router.delete("/me", auth(['ADMIN','USER']), userController.updateUser);
router.get("/me", auth(['ADMIN','USER']), userController.updateUser);
router.put("/avatar", auth(['ADMIN','USER']), uploadAvatarImage, userController.uploadAvatar);
router.put("/onboarding", auth(['ADMIN','USER']), userController.updateOnboarding);
router.get("/all", auth(['ADMIN']), userController.getUsers);
router.get("/:userId", auth(['ADMIN']), userController.getUserById);
router.delete("/:userId", auth(['ADMIN']), userController.deleteAccount);
router.post("/block/:userId", auth(['ADMIN']), userController.blockAccount);
router.post("/bulk-delete", auth(['ADMIN']), userController.bulkDeleteUsers);

export default router;
