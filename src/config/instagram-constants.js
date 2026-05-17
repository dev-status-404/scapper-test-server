// ═══════════════════════════════════════════════════════════════════════════
// Instagram Scraping Constants and Limits
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Maximum users to scrape per session (memory safe for EC2 micro - 1GB RAM)
 */
export const SAFE_SCRAPE_LIMIT = 3000;

/**
 * Maximum users to enrich with Apify (API limit safe)
 */
export const ENRICH_LIMIT = 3000;

/**
 * Domains to skip during deep scan (social platforms, tech giants, URL shorteners)
 * These sites don't typically contain contact info and waste requests
 */
export const SKIP_DOMAINS = [
  "apple.com",
  "youtube.com",
  "google.com",
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "tiktok.com",
  "snapchat.com",
  "pinterest.com",
  "reddit.com",
  "amazon.com",
  "ebay.com",
  "paypal.com",
  "github.com",
  "stackoverflow.com",
  "microsoft.com",
  "zoom.us",
  "discord.com",
  "telegram.org",
  "whatsapp.com",
  "spotify.com",
  "netflix.com",
  "t.co",
  "bit.ly",
  "tinyurl.com",
];

/**
 * GraphQL query hashes for Instagram API
 */
export const GRAPHQL_QUERY_HASHES = {
  followers: "c76146de99bb02f6415203be841dd25a",
  following: "d04b0a864b4b54837c0d870b0e77e076",
};
