import Campaign from "../models/campaign.model.js";
import { campaignService } from "./campaignService.js";
import { createNotification } from "./notificationService.js";
import { stripeService } from "./stripeService.js";
import cron from "node-cron";

export const checkScheduledCampaigns = async () => {
    try {
        const now = new Date();
        const campaigns = await Campaign.find({
            status: "SCHEDULED",
            scheduled_at: { $lte: now },
            is_deleted: false
        });
        
        for (const campaign of campaigns) {
            console.log(`Processing scheduled campaign: ${campaign._id}`);
            
            try {
                // Send the campaign using existing sendCampaign logic
                const result = await campaignService.sendCampaign(campaign._id.toString(), campaign.user_id.toString());
                
                if (result.success) {
                    console.log(`✅ Scheduled campaign ${campaign._id} sent successfully`);

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
                    }
                } else {
                    console.error(`❌ Failed to send scheduled campaign ${campaign._id}: ${result.message}`);
                    
                    // Update campaign status to indicate failure
                    await Campaign.findByIdAndUpdate(campaign._id, {
                        status: 'FAILED'
                    });
                }
            } catch (sendError) {
                console.error(`❌ Error sending scheduled campaign ${campaign._id}:`, sendError);
                
                // Update campaign status to indicate failure
                await Campaign.findByIdAndUpdate(campaign._id, {
                    status: 'FAILED'
                });
            }
        }
        
        if (campaigns.length === 0) {
            console.log('No scheduled campaigns to process at this time');
        }
    } catch (error) {
        console.error("Error checking scheduled campaigns:", error);
    }
};

// Start the cron job to run every 6 hours using node-cron
export const startCampaignCron = () => {
    console.log('🕐 Starting campaign scheduler (runs every 6 hours)');
    
    // Run immediately on start
    checkScheduledCampaigns();
    
    // Schedule to run every 6 hours using node-cron
    // Cron expression: every 6 hours (0 */6 * * *)
    const task = cron.schedule('0 */6 * * *', checkScheduledCampaigns, {
        scheduled: true,
        timezone: "UTC"
    });
    
    console.log('✅ Campaign scheduler started successfully with node-cron');
    console.log('📅 Schedule: Every 6 hours at minute 0 (00:00, 06:00, 12:00, 18:00 UTC)');

    // Expire free trials – run daily at 01:00 UTC
    cron.schedule("0 1 * * *", async () => {
      try {
        const expired = await stripeService.expireTrials();
        if (expired > 0) {
          console.log(`[Billing] Expired ${expired} free trial(s)`);
        }
      } catch (err) {
        console.error("[Billing] Trial expiry cron failed:", err.message);
      }
    }, { scheduled: true, timezone: "UTC" });

    return task;
};