import express from "express";
import auth from "../middlewares/auth.js";
import { smtpController } from "../controllers/smtpController.js";
import {
  requireActiveSubscription,
  requireSmtpSlot,
} from "../middlewares/planGuard.js";

const router = express.Router();

router.use(auth(["ADMIN", "USER"]));
router.use(requireActiveSubscription);

router.post("/accounts", requireSmtpSlot, smtpController.createSmtpAccount);
router.get("/accounts", smtpController.getSmtpAccounts);
router.get("/accounts/:id", smtpController.getSmtpAccount);
router.patch("/accounts/:id", smtpController.updateSmtpAccount);
router.delete("/accounts/:id", smtpController.deleteSmtpAccount);
router.post("/accounts/:id/test", smtpController.testSmtpAccount);
router.post("/accounts/:id/send", smtpController.sendEmail);

export default router;
