import apifyProfileProvider from "./providers/apifyProfileProvider.js";
import steadyApiProfileProvider from "./providers/steadyApiProfileProvider.js";
import graphqlRelationshipProvider from "./providers/graphqlRelationshipProvider.js";
import puppeteerRelationshipProvider from "./providers/puppeteerRelationshipProvider.js";
import apifyRelationshipProvider from "./providers/apifyRelationshipProvider.js";
import { deepScanExternalUrl } from "./deepScanService.js";
import {
  normalizeInstagramUsername,
  normalizeInstagramProfile,
  normalizeRelationshipUser,
  normalizeExternalUrl,
  normalizeContactData,
} from "./normalizers.js";
import { PROFILE_PROVIDER_TYPES, RELATIONSHIP_PROVIDER_TYPES } from "./providers/providerTypes.js";
import {
  assertProviderSupportsRelationshipType,
  normalizeRelationshipRequestType,
} from "./relationshipTypes.js";

export const enrichProfiles = async (usernames, options = {}) => {
  const provider = options.provider || PROFILE_PROVIDER_TYPES.APIFY;

  if (provider === PROFILE_PROVIDER_TYPES.STEADY_API) {
    return steadyApiProfileProvider.enrichProfiles(usernames, options);
  }

  return apifyProfileProvider.enrichProfiles(usernames, options);
};

export const enrichProfile = async (username, options = {}) => {
  const results = await enrichProfiles([username], options);
  return results.find((result) => result.success) || results[0] || null;
};

export const selectRelationshipProvider = (provider = RELATIONSHIP_PROVIDER_TYPES.GRAPHQL) => {
  if (provider === RELATIONSHIP_PROVIDER_TYPES.PUPPETEER) {
    return puppeteerRelationshipProvider;
  }
  if (provider === RELATIONSHIP_PROVIDER_TYPES.APIFY) {
    return apifyRelationshipProvider;
  }
  return graphqlRelationshipProvider;
};

export const collectRelationships = async (params) => {
  const requestType = normalizeRelationshipRequestType(params.type);
  const relationshipProvider = selectRelationshipProvider(
    params.provider || RELATIONSHIP_PROVIDER_TYPES.GRAPHQL,
  );
  assertProviderSupportsRelationshipType(relationshipProvider, requestType);
  return relationshipProvider.collectRelationships({ ...params, type: requestType });
};

const InstagramPipelineService = {
  enrichProfile,
  enrichProfiles,
  collectRelationships,
  selectRelationshipProvider,
  deepScanExternalUrl,
  providers: {
    apifyProfileProvider,
    steadyApiProfileProvider,
    graphqlRelationshipProvider,
    puppeteerRelationshipProvider,
    apifyRelationshipProvider,
  },
  normalizers: {
    normalizeInstagramUsername,
    normalizeInstagramProfile,
    normalizeRelationshipUser,
    normalizeExternalUrl,
    normalizeContactData,
  },
};

export default InstagramPipelineService;
