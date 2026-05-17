import apifyProfileProvider, {
  fetchAllApifyDatasetItems,
  normalizeAndDedupeUsernames,
  chunkUsernames,
} from "../providers/apifyProfileProvider.js";
import { ProviderEmptyResultError } from "../errors.js";

const toLegacyRawProfile = (result) => result.raw || result.profile?.raw || result.profile || null;

/**
 * Backwards-compatible single profile wrapper.
 * New code should prefer ApifyProfileProvider directly.
 */
export const scrapeWithApify = async (username, options = {}) => {
  const result = await apifyProfileProvider.enrichProfile(username, options);
  return toLegacyRawProfile(result);
};

/**
 * Backwards-compatible bulk profile wrapper.
 * New code should prefer ApifyProfileProvider directly because it returns
 * normalized provider DTOs and per-username failures.
 */
export const scrapeWithApifyBulk = async (usernames, options = {}) => {
  const results = await apifyProfileProvider.enrichProfiles(usernames, options);
  const successful = results.filter((result) => result.success).map(toLegacyRawProfile).filter(Boolean);

  if (successful.length === 0) {
    throw new ProviderEmptyResultError("No data returned from Apify bulk scrape", {
      provider: "apify",
    });
  }

  return successful;
};

export {
  apifyProfileProvider,
  fetchAllApifyDatasetItems,
  normalizeAndDedupeUsernames,
  chunkUsernames,
};

