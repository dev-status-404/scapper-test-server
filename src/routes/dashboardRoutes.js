import express from "express";
import { dashboardController } from "../controllers/dashboardController.js";
import auth from "../middlewares/auth.js";

const router = express.Router();

// Dashboard routes
router.get("/",auth(['ADMIN','USER']), dashboardController.getDashboard);

export default router;
