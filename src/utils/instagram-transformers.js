// ═══════════════════════════════════════════════════════════════════════════
// Data Transformation Functions (Apify/SteadyAPI → Lead Format)
// ═══════════════════════════════════════════════════════════════════════════

import { splitName, uniqueValues, parseCount } from "./instagram-helpers.js";
import { extractEmails, extractPhones, extractUrls } from "./extractor.js";

/**
 * Transform Apify Instagram data to internal lead format
 * @param {Object} apifyData - Raw data from Apify API
 * @returns {Object} Transformed lead data
 */
export const transformApifyToLead = (apifyData) => {
  const { first_name, last_name } = splitName(apifyData.fullName);

  // Extract emails and phones from bio
  const bioEmails = extractEmails(apifyData.biography || "");
  const bioPhones = extractPhones(apifyData.biography || "");

  // Extract external URLs
  const externalUrls = uniqueValues(
    [
      apifyData.externalUrl,
      ...extractUrls(apifyData.biography || ""),
      ...(Array.isArray(apifyData.externalUrls)
        ? apifyData.externalUrls.map((link) => link.url).filter(Boolean)
        : []),
    ].filter(Boolean),
  );

  // Build profile data structure
  const profileData = {
    instagram_profile_id: apifyData.id || null,
    username: apifyData.username || null,
    full_name: apifyData.fullName || null,
    bio: apifyData.biography || null,
    avatar_url: apifyData.profilePicUrlHD || apifyData.profilePicUrl || null,
    followers: parseCount(apifyData.followersCount),
    following: parseCount(apifyData.followsCount),
    total_posts: parseCount(apifyData.postsCount),
    category: apifyData.businessCategoryName || null,
    external_url: apifyData.externalUrl || null,
    external_url_linkshimmed: apifyData.externalUrlShimmed || null,
    external_urls: externalUrls,
    is_private: apifyData.private ?? null,
    is_verified: apifyData.verified ?? null,
    is_public: apifyData.private !== null ? !apifyData.private : null,
    highlight_reel_count: parseCount(apifyData.highlightReelCount),
    links: Array.isArray(apifyData.externalUrls) ? apifyData.externalUrls : [],
    source_url:
      apifyData.url || `https://www.instagram.com/${apifyData.username}`,
  };

  return {
    profileData,
    first_name,
    last_name,
    bioEmails,
    bioPhones,
    externalUrls,
  };
};

/**
 * Transform SteadyAPI Instagram data to internal lead format
 * @param {Object} steadyData - Raw data from SteadyAPI
 * @returns {Object} Transformed lead data
 */
export const transformSteadyAPIToLead = (steadyData) => {
  const { first_name, last_name } = splitName(steadyData.full_name);

  const bioEmails = extractEmails(steadyData.biography || "");
  const bioPhones = extractPhones(steadyData.biography || "");

  const externalUrls = uniqueValues(
    [
      steadyData.external_url,
      ...extractUrls(steadyData.biography || ""),
      ...(Array.isArray(steadyData.bio_links)
        ? steadyData.bio_links.map((link) => link.url).filter(Boolean)
        : []),
    ].filter(Boolean),
  );

  const profileData = {
    instagram_profile_id: steadyData.id || null,
    username: steadyData.username || null,
    full_name: steadyData.full_name || null,
    bio: steadyData.biography || null,
    avatar_url: steadyData.profile_pic_hd || steadyData.profile_pic || null,
    followers: parseCount(steadyData.followers),
    following: parseCount(steadyData.following),
    total_posts: parseCount(steadyData.posts),
    category: steadyData.category || null,
    external_url: steadyData.external_url || null,
    external_url_linkshimmed: null,
    external_urls: externalUrls,
    is_private: steadyData.is_private ?? null,
    is_verified: steadyData.is_verified ?? null,
    is_public: steadyData.is_private !== null ? !steadyData.is_private : null,
    highlight_reel_count: parseCount(steadyData.highlight_reel_count),
    links: Array.isArray(steadyData.bio_links) ? steadyData.bio_links : [],
    source_url:
      steadyData.profile_url ||
      `https://www.instagram.com/${steadyData.username}`,
  };

  return {
    profileData,
    first_name,
    last_name,
    bioEmails,
    bioPhones,
    externalUrls,
  };
};
