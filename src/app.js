import express from "express";
import cors from "cors";
import httpStatus from "http-status";
import { errorConverter, errorHandler } from "./middlewares/error.js";
import ApiError from "./utils/ApiError.js";
import dbConnection from "./config/db.js";
import dotenv from "dotenv";
import { startCampaignCron } from "./services/cronService.js";
import { createEmailWorker } from "./services/emailQueueService.js";
import { createInstagramFollowersWorker } from "./services/instagramFollowersQueueService.js";
import { createDeepScanWorker } from "./services/deepScanService.js";

import userRoutes from "./routes/userRoutes.js";
import scrapperRoutes from "./routes/scrapperRoutes.js";
import instaScrapeRoute from "./routes/instaScrapeRoute.js";
import betaInstaScrapeRoute from "./routes/betaInstaScrapeRoute.js";
import authRoutes from "./routes/authRoutes.js";
import folderRoutes from "./routes/folderRoutes.js";
import leadRoutes from "./routes/leadRoutes.js";
import dashboardRoutes from "./routes/dashboardRoutes.js";
import notificationRoutes from "./routes/notificationRoutes.js";
import feedbackRoutes from "./routes/feedbackRoutes.js";
import bugRoutes from "./routes/bugRoutes.js";
import campaignRoutes from "./routes/campaignRoutes.js";
import emailRoutes from "./routes/emailRoutes.js";
import smtpRoutes from "./routes/smtpRoutes.js";
import instagramAccountRoutes from "./routes/instagramAccountRoutes.js";
import adminAccountPoolRoutes from "./routes/adminAccountPoolRoutes.js";
import adminBillingRoutes from "./routes/adminBillingRoutes.js";
import emailTemplateRoutes from "./routes/emailTemplateRoutes.js";
import stripeRoutes from "./routes/stripeRoutes.js";

dotenv.config();

const app = express();

const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:5000",
  "https://master.d1rljzufkza4ik.amplifyapp.com",
  "https://app.dataharvx.com"
];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "Accept",
    "X-Requested-With",
  ],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// Stripe webhook MUST receive the raw Buffer body for signature verification.
// Register its raw parser BEFORE the global express.json() so the stream
// isn't consumed first.
app.use("/api/billing/webhook", express.raw({ type: "application/json" }));

// Parse JSON request body
app.use(express.json());

dbConnection();

// Start campaign scheduler cron job
startCampaignCron();

// Start BullMQ email worker
createEmailWorker();

// Start BullMQ Instagram followers/following worker
createInstagramFollowersWorker();

// Start BullMQ deep URL scan worker when enabled
createDeepScanWorker();

// Parse urlencoded request body
app.use(express.urlencoded({ extended: true }));

// API routes
// app.use('/api', routes);
app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/folder", folderRoutes);
app.use("/api/lead", leadRoutes);
app.use("/api/scrapper", scrapperRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/notification", notificationRoutes);
app.use("/api/feedback", feedbackRoutes);
app.use("/api/bug", bugRoutes);
app.use("/api/campaign", campaignRoutes);
app.use("/api/email", emailRoutes);
app.use("/api/smtp", smtpRoutes);
app.use("/api/insta", instaScrapeRoute);
app.use("/api/beta-insta", betaInstaScrapeRoute);
app.use("/api/instagram", instagramAccountRoutes);
app.use("/api/admin/account-pool", adminAccountPoolRoutes);
app.use("/api/admin/billing", adminBillingRoutes);
app.use("/api/email-template", emailTemplateRoutes);
app.use("/api/billing", stripeRoutes);

// Send 404 for any unknown API request
app.use((req, res, next) => {
  next(new ApiError(httpStatus.NOT_FOUND, "Not found"));
});

// Convert error to ApiError, if needed
app.use(errorConverter);

// Handle error
app.use(errorHandler);

export default app;
