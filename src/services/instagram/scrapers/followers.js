// ═══════════════════════════════════════════════════════════════════════════
// Instagram Puppeteer Followers/Following Scraper
// ═══════════════════════════════════════════════════════════════════════════
// This module re-exports the complex Puppeteer scraper from the original file
// TODO: Fully extract and refactor this 1200+ line function for better modularity

import BetaInstaServiceOriginal from "../../betaInstaService.js";

/**
 * Main followers/following scraper using Puppeteer browser automation
 *
 * Features:
 * - Optional GraphQL routing (withGraphQl flag)
 * - Database caching (skip re-scraping)
 * - Multi-account pool management
 * - Proxy integration with authentication
 * - Stealth & anti-detection (headless new mode)
 * - Memory-safe scrolling with DOM cleanup
 * - Apify bulk enrichment
 * - Concurrency lock to prevent parallel sessions
 *
 * @param {Object} params - Scraping parameters
 * @param {string} params.targetUsername - Target Instagram username
 * @param {string} params.type - "followers" or "following"
 * @param {number} params.maxLimit - Maximum users to scrape (default: 500)
 * @param {string} params.user_id - User ID for database
 * @param {string} params.folder_id - Folder ID for organization
 * @param {boolean} params.withGraphQl - Use GraphQL method instead (default: false)
 * @returns {Promise<Object>} Scraping result with users and leads
 */
export const scrapeFollowersOrFollowing =
  BetaInstaServiceOriginal.scrapeFollowersOrFollowing;

// Note: This function is temporarily delegated to the original file due to its complexity.
// It contains:
// - 300+ lines of Puppeteer browser setup
// - 400+ lines of scrolling and user extraction logic
// - 200+ lines of Apify enrichment
// - 200+ lines of database insertion
// - 100+ lines of error handling and cleanup
//
// Future refactoring could break this into:
// - browser-setup.js
// - scroll-collector.js
// - user-enrichment.js
// - database-writer.js
