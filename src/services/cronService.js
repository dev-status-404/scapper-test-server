import cron from "node-cron";
import Campaign from "../models/campaign.model.js";
import {
  bindErrorContext,
  captureException,
  captureMessage,
  withMonitoringSpan,
} from "../monitoring/index.js";
import { campaignService } from "./campaignService.js";
import { createNotification } from "./notificationService.js";
import { stripeService } from "./stripeService.js";

export const checkScheduledCampaigns = async () =>
  withMonitoringSpan(
    "cron.checkScheduledCampaigns",
    {
      op: "cron.execute",
      attributes: {
        "cron.name": "checkScheduledCampaigns",
      },
    },
    async () => {
      try {
        const now = new Date();
        const campaigns = await Campaign.find({
          status: "SCHEDULED",
          scheduled_at: { $lte: now },
          is_deleted: false,
        });

        for (const campaign of campaigns) {
          console.log(`Processing scheduled campaign: ${campaign._id}`);

          try {
            const result = await withMonitoringSpan(
              "cron.sendScheduledCampaign",
              {
                op: "cron.job",
                attributes: {
                  "cron.name": "sendScheduledCampaign",
                  "campaign.id": campaign._id.toString(),
                  "user.id": campaign.user_id?.toString?.() || null,
                },
              },
              () =>
                campaignService.sendCampaign(
                  campaign._id.toString(),
                  campaign.user_id.toString(),
                ),
            );

            if (result.success) {
              console.log(
                `Scheduled campaign ${campaign._id} sent successfully`,
              );

              try {
                await createNotification({
                  user_id: campaign.user_id,
                  title: "Scheduled campaign sent",
                  type: "info",
                  message: `Your scheduled campaign '${campaign.name}' has been sent successfully.`,
                });
              } catch (notificationError) {
                console.error(
                  `Failed to send scheduled-campaign notification for ${campaign._id}:`,
                  notificationError,
                );
                captureException(
                  notificationError,
                  bindErrorContext({
                    tags: {
                      area: "cron",
                      event: "scheduled-campaign-notification-failed",
                      campaign_id: campaign._id.toString(),
                    },
                    user: { _id: campaign.user_id },
                  }),
                );
              }

              continue;
            }

            console.error(
              `Failed to send scheduled campaign ${campaign._id}: ${result.message}`,
            );
            captureMessage("scheduled-campaign-send-failed", {
              level: "error",
              tags: {
                area: "cron",
                event: "scheduled-campaign-send-failed",
                campaign_id: campaign._id.toString(),
              },
              user: { _id: campaign.user_id },
              extra: {
                message: result.message,
              },
            });

            await Campaign.findByIdAndUpdate(campaign._id, {
              status: "FAILED",
            });
          } catch (sendError) {
            console.error(
              `Error sending scheduled campaign ${campaign._id}:`,
              sendError,
            );
            captureException(
              sendError,
              bindErrorContext({
                tags: {
                  area: "cron",
                  event: "scheduled-campaign-send-error",
                  campaign_id: campaign._id.toString(),
                },
                user: { _id: campaign.user_id },
              }),
            );

            await Campaign.findByIdAndUpdate(campaign._id, {
              status: "FAILED",
            });
          }
        }

        if (campaigns.length === 0) {
          console.log("No scheduled campaigns to process at this time");
        }
      } catch (error) {
        console.error("Error checking scheduled campaigns:", error);
        captureException(
          error,
          bindErrorContext({
            tags: { area: "cron", event: "check-scheduled-campaigns-error" },
          }),
        );
      }
    },
  );

export const startCampaignCron = () => {
  console.log("Starting campaign scheduler (runs every 6 hours)");

  checkScheduledCampaigns();

  const task = cron.schedule("0 */6 * * *", checkScheduledCampaigns, {
    scheduled: true,
    timezone: "UTC",
  });

  console.log("Campaign scheduler started successfully with node-cron");
  console.log(
    "Schedule: Every 6 hours at minute 0 (00:00, 06:00, 12:00, 18:00 UTC)",
  );

  cron.schedule(
    "0 1 * * *",
    async () => {
      try {
        const expired = await withMonitoringSpan(
          "cron.expireTrials",
          {
            op: "cron.job",
            attributes: {
              "cron.name": "expireTrials",
            },
          },
          () => stripeService.expireTrials(),
        );

        if (expired > 0) {
          console.log(`[Billing] Expired ${expired} free trial(s)`);
        }
      } catch (err) {
        console.error("[Billing] Trial expiry cron failed:", err.message);
        captureException(
          err,
          bindErrorContext({
            tags: { area: "cron", event: "trial-expiry-cron-failed" },
          }),
        );
      }
    },
    { scheduled: true, timezone: "UTC" },
  );

  return task;
};
