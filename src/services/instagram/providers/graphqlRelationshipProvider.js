import { scrapeFollowersOrFollowingGraphQL } from "../scrapers/graphql.js";
import { normalizeInstagramUsername } from "../normalizers.js";
import {
  RELATIONSHIP_PROVIDER_CAPABILITIES,
  RELATIONSHIP_PROVIDER_TYPES,
} from "./providerTypes.js";
import {
  assertProviderSupportsRelationshipType,
  normalizeRelationshipRequestType,
  toRelationshipDirection,
} from "../relationshipTypes.js";

export class GraphQLRelationshipProvider {
  provider = RELATIONSHIP_PROVIDER_TYPES.GRAPHQL;
  capabilities = RELATIONSHIP_PROVIDER_CAPABILITIES[RELATIONSHIP_PROVIDER_TYPES.GRAPHQL];

  async collectRelationships({
    targetUsername,
    type = "followers",
    limit,
    cursor = null,
    jobId = null,
    chunkSize = null,
    pauseChecker = null,
    user_id,
    folder_id,
  }) {
    const normalizedTarget = normalizeInstagramUsername(targetUsername);
    const requestType = normalizeRelationshipRequestType(type);
    assertProviderSupportsRelationshipType(this, requestType);

    const response = await scrapeFollowersOrFollowingGraphQL({
      targetUsername: normalizedTarget,
      type: requestType,
      maxLimit: limit,
      user_id,
      folder_id,
      __checkPause: pauseChecker,
      cursor,
      jobId,
      chunkSize,
    });

    return {
      provider: RELATIONSHIP_PROVIDER_TYPES.GRAPHQL,
      success: Boolean(response?.success),
      status: response?.success ? "SUCCEEDED" : "FAILED",
      target_username: normalizedTarget,
      type: requestType,
      relationship_type: toRelationshipDirection(requestType),
      collected_count: response?.data?.count || 0,
      cursor: response?.data?.cursor || null,
      raw: response,
    };
  }
}

export const graphqlRelationshipProvider = new GraphQLRelationshipProvider();

export default graphqlRelationshipProvider;
