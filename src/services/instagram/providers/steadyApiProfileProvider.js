import { scrapeWithSteadyAPI } from "../integrations/steady-api.js";
import { normalizeInstagramProfile, normalizeInstagramUsername } from "../normalizers.js";
import { PROFILE_PROVIDER_TYPES } from "./providerTypes.js";

export class SteadyApiProfileProvider {
  provider = PROFILE_PROVIDER_TYPES.STEADY_API;
  capabilities = {
    provider: PROFILE_PROVIDER_TYPES.STEADY_API,
    supportsFollowers: false,
    supportsFollowing: false,
    supportsCursorResume: false,
    supportsProfileEnrichment: true,
  };

  async enrichProfile(username, options = {}) {
    const normalizedUsername = normalizeInstagramUsername(username);
    const raw = await scrapeWithSteadyAPI(normalizedUsername, options);
    const profile = normalizeInstagramProfile(
      { ...raw, username: raw?.username || normalizedUsername },
      PROFILE_PROVIDER_TYPES.STEADY_API,
    );

    return {
      provider: PROFILE_PROVIDER_TYPES.STEADY_API,
      source: PROFILE_PROVIDER_TYPES.STEADY_API,
      success: true,
      username: profile.username,
      profile,
      raw,
    };
  }

  async enrichProfiles(usernames, options = {}) {
    const inputs = Array.isArray(usernames) ? usernames : [usernames];
    const results = [];

    for (const username of inputs) {
      try {
        results.push(await this.enrichProfile(username, options));
      } catch (error) {
        results.push({
          provider: PROFILE_PROVIDER_TYPES.STEADY_API,
          source: PROFILE_PROVIDER_TYPES.STEADY_API,
          success: false,
          username: String(username || ""),
          error_type: error.name || "SteadyApiError",
          error_message: error.message,
        });
      }
    }

    return results;
  }
}

export const steadyApiProfileProvider = new SteadyApiProfileProvider();

export default steadyApiProfileProvider;
