// ═══════════════════════════════════════════════════════════════════════════
// Instagram Scraping Service - Main Entry Point
// ═══════════════════════════════════════════════════════════════════════════

import BetaInstagramService from "../betaInstaService.js";
import InstagramPipelineService, { collectRelationships } from "./instaService.js";
import { scrapeFollowersOrFollowingGraphQL } from "./scrapers/graphql.js";
import apifyProfileProvider from "./providers/apifyProfileProvider.js";
import steadyApiProfileProvider from "./providers/steadyApiProfileProvider.js";
import instagramApiProfileProvider from "./providers/instagramApiProfileProvider.js";
import graphqlRelationshipProvider from "./providers/graphqlRelationshipProvider.js";
import puppeteerRelationshipProvider from "./providers/puppeteerRelationshipProvider.js";
import apifyRelationshipProvider from "./providers/apifyRelationshipProvider.js";

const InstagramService = {
  // Single & Bulk Profile Scrapers
  scrapeInstagram: BetaInstagramService.scrapeInstagram,
  scrapeInstagramBulk: BetaInstagramService.scrapeInstagramBulk,

  // Followers/Following Scrapers
  // scrapeFollowersOrFollowing: Puppeteer scraper — still in betaInstaService pending extraction
  scrapeFollowersOrFollowing: BetaInstagramService.scrapeFollowersOrFollowing,
  scrapeFollowersOrFollowingGraphQL,
  collectRelationships,

  // Deep Scan
  deepScanExternalUrl: BetaInstagramService.deepScanExternalUrl,

  // Provider-based pipeline entry point
  pipeline: InstagramPipelineService,
  providers: {
    apifyProfileProvider,
    steadyApiProfileProvider,
    instagramApiProfileProvider,
    graphqlRelationshipProvider,
    puppeteerRelationshipProvider,
    apifyRelationshipProvider,
  },
};

export default InstagramService;
