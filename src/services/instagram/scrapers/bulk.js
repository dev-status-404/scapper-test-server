// ═══════════════════════════════════════════════════════════════════════════
// Bulk Instagram Profiles Scraper
// ═══════════════════════════════════════════════════════════════════════════

import Lead from "../../../models/lead.model.js";
import userLeadService from "../../userLeadService.js";
import { uniqueValues } from "../../../utils/instagram-helpers.js";
import { transformApifyToLead } from "../../../utils/instagram-transformers.js";
import { scrapeWithApifyBulk } from "../integrations/apify.js";
import { normalizeInstagramUsername } from "../normalizers.js";

/**
 * Scrape multiple Instagram profiles in bulk
 * @param {Object} params - Scraping parameters
 * @param {string[]} params.profileUrls - Array of Instagram profile URLs
 * @param {string} params.user_id - User ID for database
 * @param {string} params.folder_id - Folder ID for organization
 * @returns {Promise<Object>} Bulk scraping result
 */
export const scrapeInstagramBulk = async ({
  profileUrls,
  user_id,
  folder_id,
}) => {
  if (!profileUrls || !Array.isArray(profileUrls) || profileUrls.length === 0) {
    return {
      code: 400,
      success: false,
      message: "profileUrls array is required and cannot be empty",
    };
  }

  console.log(`[Bulk] Starting bulk scrape for ${profileUrls.length} profiles`);

  // Extract all usernames from profile URLs
  const usernames = [];
  const usernameToUrlMap = new Map();
  const results = [];
  let invalidCount = 0;

  for (const profileUrl of profileUrls) {
    try {
      const username = normalizeInstagramUsername(profileUrl);
      usernames.push(username);
      usernameToUrlMap.set(username.toLowerCase(), profileUrl);
    } catch {
      invalidCount++;
      results.push({
        profileUrl,
        username: null,
        success: false,
        error: "invalid-instagram-url",
      });
    }
  }

  if (usernames.length === 0) {
    return {
      code: 400,
      success: false,
      message: "No valid usernames found in profileUrls",
    };
  }

  console.log(`[Bulk] Extracted ${usernames.length} valid usernames`);

  const leadsToInsert = [];
  let successCount = 0;
  let failCount = invalidCount;

  try {
    // Call Apify with all usernames in one request
    console.log(
      `[Bulk] Sending bulk request to Apify for ${usernames.length} profiles...`,
    );
    const apifyBulkData = await scrapeWithApifyBulk(usernames);

    // Process each result from Apify
    for (const apifyData of apifyBulkData) {
      try {
        const transformed = transformApifyToLead(apifyData);
        const {
          profileData,
          first_name,
          last_name,
          bioEmails,
          bioPhones,
          externalUrls,
        } = transformed;

        // Unique values
        const allEmails = uniqueValues(bioEmails);
        const allPhones = uniqueValues(bioPhones);

        // Get original profile URL
        const originalUrl =
          usernameToUrlMap.get(profileData.username?.toLowerCase()) ||
          profileData.source_url;

        // Prepare lead data for bulk insert
        const leadData = {
          first_name,
          last_name,
          company: profileData.username || "",
          emails: allEmails,
          phone_numbers: allPhones,
          message: `
Instagram Profile Scraped (Bulk)

Username: ${profileData.username || "N/A"}
Full Name: ${profileData.full_name || "N/A"}
Bio: ${profileData.bio || "N/A"}
Followers: ${profileData.followers || "N/A"}
Following: ${profileData.following || "N/A"}
Profile URL: ${profileData.source_url}
Scraped with: APIFY
          `.trim(),
          source_url: profileData.source_url,
          source_rul: profileData.source_url,
          instagram_profile_id: profileData.instagram_profile_id,
          username: profileData.username,
          full_name: profileData.full_name,
          bio: profileData.bio,
          avatar_url: profileData.avatar_url,
          avatar_rul: profileData.avatar_url,
          followers: profileData.followers,
          following: profileData.following,
          follower_count: profileData.followers,
          following_count: profileData.following,
          total_posts: profileData.total_posts,
          category: profileData.category,
          external_url: profileData.external_url,
          external_url_linkshimmed: profileData.external_url_linkshimmed,
          external_urls: profileData.external_urls,
          is_private: profileData.is_private,
          is_verified: profileData.is_verified,
          is_public: profileData.is_public,
          fb_profile_biolink: null,
          highlight_reel_count: profileData.highlight_reel_count,
          links: profileData.links,
          folder_id: folder_id || null,
          user_id: user_id || null,
          type: "INSTAGRAM",
        };

        leadsToInsert.push(leadData);

        results.push({
          profileUrl: originalUrl,
          username: profileData.username,
          success: true,
          scraped_with: "apify",
          profile: profileData,
        });

        successCount++;
      } catch (transformError) {
        console.error(
          `[Bulk] Error transforming profile data:`,
          transformError.message,
        );
        results.push({
          profileUrl: apifyData.url || "unknown",
          username: apifyData.username || "unknown",
          success: false,
          error: transformError.message,
        });
        failCount++;
      }
    }

    console.log(
      `[Bulk] Processed ${successCount} profiles successfully, ${failCount} failed`,
    );
  } catch (apifyError) {
    console.error(`[Bulk] Apify bulk scrape failed:`, apifyError.message);

    // If bulk Apify fails, mark all as failed
    for (const username of usernames) {
      results.push({
        profileUrl: usernameToUrlMap.get(username.toLowerCase()),
        username: username,
        success: false,
        error: apifyError.message,
      });
      failCount++;
    }
  }

  // Bulk insert all leads into MongoDB
  let insertedLeads = [];
  if (leadsToInsert.length > 0) {
    try {
      console.log(
        `[Bulk] Inserting ${leadsToInsert.length} leads into database...`,
      );
      if (user_id) {
        const bulkResult = await userLeadService.bulkResolveOrCreate(
          leadsToInsert,
          {
            user_id,
            folder_id,
            type: "INSTAGRAM",
          },
        );
        insertedLeads = bulkResult.insertedLeads;
        console.log(
          `[Bulk] Database done - new: ${bulkResult.newCount}, cached: ${bulkResult.cachedCount}`,
        );
      } else {
        insertedLeads = await Lead.insertMany(leadsToInsert, { ordered: false });
        console.log(`[Bulk] Successfully inserted ${insertedLeads.length} leads`);
      }
    } catch (dbError) {
      console.error("[Bulk] Database bulk insert error:", dbError.message);
      // Even if some fail, insertMany with ordered:false will continue
      // Check if any were inserted
      if (dbError.insertedDocs) {
        insertedLeads = dbError.insertedDocs;
      }
    }
  }

  return {
    code: 200,
    success: true,
    message: "bulk-instagram-scraping-completed",
    data: {
      total: profileUrls.length,
      success: successCount,
      failed: failCount,
      leads_inserted: insertedLeads.length,
      results: results,
      leads: insertedLeads,
    },
  };
};
