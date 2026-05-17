// ═══════════════════════════════════════════════════════════════════════════
// Single Instagram Profile Scraper
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from "crypto";
import Lead from "../../../models/lead.model.js";
import userLeadService from "../../userLeadService.js";
import { uniqueValues } from "../../../utils/instagram-helpers.js";
import {
  transformApifyToLead,
  transformSteadyAPIToLead,
} from "../../../utils/instagram-transformers.js";
import { scrapeWithApify } from "../integrations/apify.js";
import { scrapeWithSteadyAPI } from "../integrations/steady-api.js";
import {
  DEEP_SCAN_INLINE_SINGLE_PROFILE,
  deepScanExternalUrl,
  enqueueDeepScanBatch,
} from "../../deepScanService.js";
import { normalizeInstagramUsername } from "../normalizers.js";

/**
 * Scrape a single Instagram profile
 * @param {Object} params - Scraping parameters
 * @param {string} params.profileUrl - Instagram profile URL
 * @param {string} params.user_id - User ID for database
 * @param {string} params.folder_id - Folder ID for organization
 * @returns {Promise<Object>} Scraping result
 */
export const scrapeInstagram = async ({ profileUrl, user_id, folder_id }) => {
  if (!profileUrl) {
    return {
      code: 400,
      success: false,
      message: "instagram-profile-url-is-required",
    };
  }

  let username;
  try {
    username = normalizeInstagramUsername(profileUrl);
  } catch (error) {
    return {
      code: 400,
      success: false,
      message: "invalid-instagram-url",
      error: error.message,
    };
  }

  // Return cached lead if already scraped by this user
  if (user_id) {
    const existing = await Lead.findOne({
      user_id,
      username,
      type: "INSTAGRAM",
      is_deleted: { $ne: true },
    }).sort({ createdAt: -1 });

    if (existing) {
      console.log(`[Instagram] Returning cached lead for @${username}`);
      return {
        code: 200,
        success: true,
        message: "instagram-profile-already-scraped",
        scraped_with: "cache",
        data: {
          scrape_id: existing.scrape_id || null,
          lead: existing,
          profile: {},
          deep_scan: { scanned_urls: 0, results: [], total_emails_found: 0, total_phones_found: 0 },
        },
      };
    }
  }

  let profileData;
  let first_name, last_name, bioEmails, bioPhones, externalUrls;
  let scrapedWith = "apify";

  // Try Apify first
  try {
    const apifyData = await scrapeWithApify(username);
    const transformed = transformApifyToLead(apifyData);
    profileData = transformed.profileData;
    first_name = transformed.first_name;
    last_name = transformed.last_name;
    bioEmails = transformed.bioEmails;
    bioPhones = transformed.bioPhones;
    externalUrls = transformed.externalUrls;
  } catch (apifyError) {
    console.log("[Main] Apify failed, trying SteadyAPI fallback");

    // Fallback to SteadyAPI
    try {
      const steadyData = await scrapeWithSteadyAPI(username);
      const transformed = transformSteadyAPIToLead(steadyData);
      profileData = transformed.profileData;
      first_name = transformed.first_name;
      last_name = transformed.last_name;
      bioEmails = transformed.bioEmails;
      bioPhones = transformed.bioPhones;
      externalUrls = transformed.externalUrls;
      scrapedWith = "steadyapi";
    } catch (steadyError) {
      console.log("[Main] Both Apify and SteadyAPI failed");
      return {
        code: 500,
        success: false,
        message: "failed-to-scrape-instagram-profile",
        errors: {
          apify: apifyError.message,
          steadyapi: steadyError.message,
        },
      };
    }
  }

  // Perform deep scan on external URLs
  let deepScanResults = [];
  let allEmails = [...bioEmails];
  let allPhones = [...bioPhones];
  let skippedCount = 0;

  if (DEEP_SCAN_INLINE_SINGLE_PROFILE && externalUrls.length > 0) {
    console.log(`[Main] Starting deep scan for ${externalUrls.length} URLs`);

    for (const url of externalUrls) {
      const scanResult = await deepScanExternalUrl(url);

      if (scanResult.skipped) {
        skippedCount++;
      }

      deepScanResults.push(scanResult);

      if (scanResult.emails.length > 0) {
        allEmails.push(...scanResult.emails);
      }
      if (scanResult.phone_numbers.length > 0) {
        allPhones.push(...scanResult.phone_numbers);
      }

      // Small delay between requests
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    console.log(
      `[Main] Deep scan completed. Scanned: ${externalUrls.length - skippedCount}, Skipped: ${skippedCount}`,
    );
  }

  // Unique values
  allEmails = uniqueValues(allEmails);
  allPhones = uniqueValues(allPhones);

  // Create Lead in database
  const scrapeId = randomUUID();
  try {
    const leadPayload = {
      first_name,
      last_name,
      company: profileData.username || "",
      emails: allEmails,
      phone_numbers: allPhones,
      scrape_id: scrapeId,
      scraped_from_username: username,
      message: `
Instagram Profile Scraped

Username: ${profileData.username || "N/A"}
Full Name: ${profileData.full_name || "N/A"}
Bio: ${profileData.bio || "N/A"}
Followers: ${profileData.followers || "N/A"}
Following: ${profileData.following || "N/A"}
Profile URL: ${profileData.source_url}
Scraped with: ${scrapedWith.toUpperCase()}
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

    const { lead, fromCache } = user_id
      ? await userLeadService.resolveOrCreateLead(leadPayload, {
          user_id,
          folder_id,
          type: "INSTAGRAM",
          scraped_from_username: username,
        })
      : { lead: await Lead.create(leadPayload), fromCache: false };

    if (!DEEP_SCAN_INLINE_SINGLE_PROFILE && externalUrls.length > 0) {
      enqueueDeepScanBatch({
        user_id,
        lead_ids: externalUrls.map(() => lead?._id),
        urls: externalUrls,
        job_id: scrapeId,
      }).catch((error) => {
        console.warn(
          `[DeepScan] enqueue failed for @${profileData.username}: ${error.message}`,
        );
      });
    }

    return {
      code: 200,
      success: true,
      message: fromCache
        ? "instagram-profile-fetched-from-cache"
        : "instagram-profile-scraped-successfully",
      scraped_with: scrapedWith,
      from_cache: fromCache,
      data: {
        scrape_id: scrapeId,
        lead,
        profile: profileData,
        deep_scan: {
          scanned_urls: deepScanResults.length,
          results: deepScanResults,
          total_emails_found: allEmails.length,
          total_phones_found: allPhones.length,
        },
      },
    };
  } catch (dbError) {
    console.error("[Main] Database error:", dbError);
    return {
      code: 500,
      success: false,
      message: "failed-to-save-lead-to-database",
      error: dbError.message,
    };
  }
};
