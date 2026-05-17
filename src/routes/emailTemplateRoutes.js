import express from "express";
import { emailTemplateController } from "../controllers/emailTemplateController.js";

const router = express.Router();

router.post("/create", emailTemplateController.createTemplate);
router.get("/get", emailTemplateController.getTemplates);
router.get("/get-by-id", emailTemplateController.getTemplateById);
router.post("/update", emailTemplateController.updateTemplate);
router.delete("/delete", emailTemplateController.deleteTemplate);

export default router;
