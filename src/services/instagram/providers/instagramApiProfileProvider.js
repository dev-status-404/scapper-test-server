import { normalizeInstagramProfile, normalizeInstagramUsername } from "../normalizers.js";
import { PROFILE_PROVIDER_TYPES } from "./providerTypes.js";

/**
 * Placeholder provider for first-party/session-backed Instagram profile detail.
 * The existing implementation currently lives in betaInstaService.js. This
 * adapter keeps the provider boundary explicit without moving the large legacy
 * function in one risky step.
 */
export class InstagramApiProfileProvider {
  provider = PROFILE_PROVIDER_TYPES.INSTAGRAM_API;
  capabilities = {
    provider: PROFILE_PROVIDER_TYPES.INSTAGRAM_API,
    supportsFollowers: false,
    supportsFollowing: false,
    supportsCursorResume: false,
    supportsProfileEnrichment: true,
  };

  constructor({ fetchProfile } = {}) {
    this.fetchProfile = fetchProfile;
  }

  async enrichProfile(username, options = {}) {
    const normalizedUsername = normalizeInstagramUsername(username);
    if (typeof this.fetchProfile !== "function") {
      return {
        provider: PROFILE_PROVIDER_TYPES.INSTAGRAM_API,
        source: PROFILE_PROVIDER_TYPES.INSTAGRAM_API,
        success: false,
        username: normalizedUsername,
        error_type: "ProviderNotConfigured",
        error_message: "instagram-api-profile-provider-not-configured",
      };
    }

    const raw = await this.fetchProfile(normalizedUsername, options);
    const profile = normalizeInstagramProfile(
      { ...raw, username: raw?.username || normalizedUsername },
      PROFILE_PROVIDER_TYPES.INSTAGRAM_API,
    );

    return {
      provider: PROFILE_PROVIDER_TYPES.INSTAGRAM_API,
      source: PROFILE_PROVIDER_TYPES.INSTAGRAM_API,
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
          provider: PROFILE_PROVIDER_TYPES.INSTAGRAM_API,
          source: PROFILE_PROVIDER_TYPES.INSTAGRAM_API,
          success: false,
          username: String(username || ""),
          error_type: error.name || "InstagramApiProfileError",
          error_message: error.message,
        });
      }
    }

    return results;
  }
}

export const instagramApiProfileProvider = new InstagramApiProfileProvider();

export default instagramApiProfileProvider;
