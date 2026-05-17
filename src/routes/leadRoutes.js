import express from "express";
const router = express.Router();
import { leadController } from "../controllers/leadController.js";

// Lead routes
router.post("/create", leadController.createLead);
router.get("/get", leadController.getLead);
router.post("/update", leadController.updateLead);
router.delete("/delete", leadController.deleteLead);
router.get("/summary", leadController.getLeadSummary);
router.get("/scrape-stats", leadController.getLeadScrapeStats);
router.post("/bulk-delete", leadController.bulkDeleteLead);
router.post("/bulk-upload", leadController.bulkUploadLeads);
router.post("/bulk-update-scraped", leadController.updateBulkScrappedLeads);
router.get("/download", leadController.downloadAllLeads);

export default router;
