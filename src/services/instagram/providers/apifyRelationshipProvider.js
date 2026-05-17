import {
  RELATIONSHIP_PROVIDER_CAPABILITIES,
  RELATIONSHIP_PROVIDER_TYPES,
} from "./providerTypes.js";
import { assertProviderSupportsRelationshipType, normalizeRelationshipRequestType } from "../relationshipTypes.js";

/**
 * Apify relationship scraping is intentionally fail-fast unless a verified
 * actor integration is added. The current Apify actor is profile enrichment
 * only, so we do not pretend it can collect followers/following.
 */
export class ApifyRelationshipProvider {
  provider = RELATIONSHIP_PROVIDER_TYPES.APIFY;
  capabilities = RELATIONSHIP_PROVIDER_CAPABILITIES[RELATIONSHIP_PROVIDER_TYPES.APIFY];

  async collectRelationships({ type = "followers" } = {}) {
    const requestType = normalizeRelationshipRequestType(type);
    assertProviderSupportsRelationshipType(this, requestType);
  }
}

export const apifyRelationshipProvider = new ApifyRelationshipProvider();

export default apifyRelationshipProvider;

