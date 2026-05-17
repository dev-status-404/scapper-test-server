// ═══════════════════════════════════════════════════════════════════════════
// SteadyAPI Instagram Profile Scraper (Fallback Integration)
// ═══════════════════════════════════════════════════════════════════════════

import axios from "axios";

/**
 * Scrape Instagram profile using SteadyAPI as fallback
 * @param {string} username - Instagram username to scrape
 * @returns {Promise<Object>} Scraped profile data
 */
export const scrapeWithSteadyAPI = async (username) => {
  console.log(`[SteadyAPI] Fallback scrape for username: ${username}`);

  try {
    const response = await axios.get(
      `https://api.steadyapi.com/v1/instagram/profile?username=${username}`,
      {
        timeout: 30000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      },
    );

    if (!response.data?.body) {
      throw new Error("Invalid response from SteadyAPI");
    }

    console.log("[SteadyAPI] Successfully scraped profile");
    return response.data.body;
  } catch (error) {
    console.log("[SteadyAPI] Error:", error.message);
    throw error;
  }
};
