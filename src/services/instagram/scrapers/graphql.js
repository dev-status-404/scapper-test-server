// ═══════════════════════════════════════════════════════════════════════════
// Instagram GraphQL Followers/Following Scraper — Cycle-Based Architecture
// Pipeline per cycle: Fetch 100 → Apify Enrich → Deep-Scan → Save → Repeat
// ═══════════════════════════════════════════════════════════════════════════

import axios from "axios";
import Lead from "../../../models/lead.model.js";
import accountPool from "../../accountPoolService.js";
import { splitName, humanDelay } from "../../../utils/instagram-helpers.js";
import { scrapeWithApify, scrapeWithApifyBulk } from "../integrations/apify.js";
import {
  DEEP_SCAN_RELATIONSHIP_ENABLED,
  enqueueDeepScanBatch,
} from "../../deepScanService.js";
import {
  refundUnusedScrapedProfileCredits,
  reserveScrapedProfileCredits,
} from "../../scrapeCreditService.js";
import {
  ENRICH_LIMIT,
  GRAPHQL_QUERY_HASHES,
} from "../../../config/instagram-constants.js";
import { instagramConfig } from "../../../config/instagram.js";
import {
  relationshipScrapeTitle,
  toRelationshipDirection,
} from "../relationshipTypes.js";

const GRAPHQL_BATCH_SIZE = 50;             // Instagram's max per request
const MAX_RETRIES_PER_CYCLE = 3;            // Retries per cycle on 429/transient errors
const MAX_CONSECUTIVE_FAILURES = 5;         // Hard-abort after N consecutive failed cycles
const RATE_LIMIT_BACKOFF_BASE_MS = 15_000;  // 15s base, doubles each retry
const INTER_CYCLE_DELAY = [800, 1500];      // Humanized pause between cycles (ms)

// ─── Fetch one GraphQL page with exponential backoff on 429 ──────────────────

async function fetchGraphQLPage({
  graphqlUrl,
  queryHash,
  userId,
  afterCursor,
  cookieString,
  csrftoken,
  type,
  attempt = 0,
}) {
  const variables = {
    id: userId,
    include_reel: true,
    fetch_mutual: false,
    first: GRAPHQL_BATCH_SIZE,
    ...(afterCursor ? { after: afterCursor } : {}),
  };

  try {
    const response = await axios.get(graphqlUrl, {
      params: {
        query_hash: queryHash,
        variables: JSON.stringify(variables),
      },
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Cookie: cookieString,
        "X-CSRFToken": csrftoken,
        "X-Requested-With": "XMLHttpRequest",
        "X-IG-App-ID": "936619743392459",
      },
      timeout: 30_000,
    });

    const edgeKey = type === "followers" ? "edge_followed_by" : "edge_follow";
    const data = response.data?.data?.user?.[edgeKey];

    if (!data) {
      throw new Error("Invalid GraphQL response structure — session may have expired");
    }

    return {
      edges: data.edges || [],
      hasNextPage: data.page_info?.has_next_page || false,
      endCursor: data.page_info?.end_cursor || null,
    };
  } catch (err) {
    const status = err.response?.status;

    if ((status === 429 || status === 503) && attempt < MAX_RETRIES_PER_CYCLE) {
      const backoff = RATE_LIMIT_BACKOFF_BASE_MS * Math.pow(2, attempt);
      console.warn(
        `[Instagram GraphQL] HTTP ${status} — backing off ${backoff / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES_PER_CYCLE})`,
      );
      await humanDelay(backoff, backoff + 5_000);
      return fetchGraphQLPage({
        graphqlUrl, queryHash, userId, afterCursor,
        cookieString, csrftoken, type,
        attempt: attempt + 1,
      });
    }

    throw err;
  }
}

// ─── Deep-scan external URLs with bounded concurrency ────────────────────────

async function deepScanBatch(users) {
  return users.map((user) => ({ ...user, deep_scan: null }));
}

// ─── Build a Lead document from enriched + deep-scanned user ─────────────────

function buildLeadDoc({ user, type, targetUsername, folder_id, user_id }) {
  const { first_name, last_name } = splitName(user.full_name || "");
  const scan = user.deep_scan;

  return {
    first_name,
    last_name,
    company: user.username || "",
    emails: [...new Set([...(user.emails || []), ...(scan?.emails || [])])],
    phone_numbers: [
      ...new Set([...(user.phone_numbers || []), ...(scan?.phone_numbers || [])]),
    ],
    message: `
${relationshipScrapeTitle(type)} (GraphQL)

Target Profile: @${targetUsername}
Username: @${user.username || "N/A"}
Full Name: ${user.full_name || "N/A"}
Bio: ${user.bio || "N/A"}
Followers: ${user.followers || "N/A"}
Following: ${user.following || "N/A"}
Posts: ${user.posts_count || "N/A"}
Verified: ${user.is_verified ? "Yes" : "No"}
Private: ${user.is_private ? "Yes" : "No"}
Category: ${user.category || "N/A"}
External URL: ${user.external_url || "N/A"}
Deep Scan URL: ${scan?.source_url || "N/A"}
Profile URL: https://www.instagram.com/${user.username}
Scraping Method: GraphQL API
    `.trim(),
    scraped_from_username: targetUsername,
    relationship_type: toRelationshipDirection(type),
    source_url: `https://www.instagram.com/${user.username}`,
    source_rul: `https://www.instagram.com/${user.username}`,
    instagram_profile_id: user.id !== user.username ? user.id : null,
    username: user.username,
    full_name: user.full_name,
    bio: user.bio,
    avatar_url: user.avatar,
    avatar_rul: user.avatar,
    followers: user.followers,
    following: user.following,
    follower_count: user.followers,
    following_count: user.following,
    total_posts: user.posts_count,
    category: user.category,
    external_url: user.external_url,
    external_url_linkshimmed: null,
    external_urls: user.external_url ? [user.external_url] : [],
    is_private: user.is_private,
    is_verified: user.is_verified,
    is_public: user.is_private !== null ? !user.is_private : null,
    fb_profile_biolink: null,
    highlight_reel_count: null,
    links: [],
    folder_id: folder_id || null,
    user_id: user_id || null,
    type: "INSTAGRAM",
  };
}

// ─── Main scraper ─────────────────────────────────────────────────────────────

export const scrapeFollowersOrFollowingGraphQL = async ({
  targetUsername,
  type = "followers",
  maxLimit = 500,
  user_id,
  folder_id,
  __checkPause,
}) => {
  console.log(
    `[Instagram GraphQL] Starting ${type} scraper for @${targetUsername}`,
  );

  let igAccount = null;

  try {
    // ── Database cache check ────────────────────────────────────────────────
    try {
      const existingLeads = await Lead.find({
        scraped_from_username: targetUsername,
        relationship_type: toRelationshipDirection(type),
        user_id,
        is_deleted: false,
      })
        .select("_id username")
        .lean();

      if (existingLeads.length > 0) {
        console.log(
          `[Instagram GraphQL] Found ${existingLeads.length} cached ${type} — returning without scraping`,
        );
        return {
          code: 200,
          success: true,
          message: `${type}-retrieved-from-database`,
          data: {
            target_username: targetUsername,
            type,
            count: existingLeads.length,
            enriched_count: existingLeads.length,
            leads_inserted: 0,
            max_limit: maxLimit,
            completion_percentage: 100,
            status_message: `Retrieved ${existingLeads.length} existing ${type} from database`,
            scraping_method: "Database Cache (GraphQL)",
            cached: true,
          },
        };
      }

      console.log(
        `[Instagram GraphQL] No cached data found — starting fresh scrape`,
      );
    } catch (dbErr) {
      console.warn(`[Instagram GraphQL] DB cache check failed: ${dbErr.message}`);
    }

    // ── Account pool ────────────────────────────────────────────────────────
    console.log("[Instagram GraphQL] Acquiring account from pool...");
    igAccount = await accountPool.getNextAccount(user_id);
    console.log(`[Instagram GraphQL] Using account: @${igAccount.username}`);

    const cookies = igAccount.getCookies();
    if (!cookies || !Array.isArray(cookies)) {
      const err = new Error(
        `Cookie decryption failed for @${igAccount.username}. ` +
          `Ensure COOKIE_ENCRYPTION_KEY is set in .env.`,
      );
      err.name = "CookieDecryptionError";
      throw err;
    }

    const sessionCookie = cookies.find((c) => c.name === "sessionid");
    const csrfCookie = cookies.find((c) => c.name === "csrftoken");

    if (!sessionCookie || !csrfCookie) {
      throw new Error(
        "Session cookies not found. Please login via Puppeteer first.",
      );
    }

    const csrftoken = csrfCookie.value;
    const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    console.log(`[Instagram GraphQL] Session loaded (${cookies.length} cookies)`);

    // ── Resolve target user ID via Apify ────────────────────────────────────
    console.log(
      `[Instagram GraphQL] Resolving user ID for @${targetUsername} via Apify...`,
    );
    const apifyProfile = await scrapeWithApify(targetUsername);
    const userId = apifyProfile.id;
    const totalOnProfile = apifyProfile.followersCount || apifyProfile.followsCount || null;

    if (!userId) {
      throw new Error(`Apify returned no user ID for @${targetUsername}`);
    }

    console.log(
      `[Instagram GraphQL] Resolved user ID: ${userId}` +
        (totalOnProfile ? ` | Total ${type} on profile: ${totalOnProfile.toLocaleString()}` : ""),
    );

    // ── Cycle-based pipeline: Fetch 100 → Enrich → Deep-Scan → Save → Repeat ─
    const queryHash = GRAPHQL_QUERY_HASHES[type];
    const graphqlUrl = "https://www.instagram.com/graphql/query/";

    let afterCursor = null;
    let hasNextPage = true;
    let cycleCount = 0;
    let totalCollected = 0;
    let totalInserted = 0;
    let consecutiveFailures = 0;
    const seenUsernames = new Set();

    while (hasNextPage && totalCollected < maxLimit) {
      // Pause-check at every cycle boundary — worker updates job.data.__control
      if (__checkPause && (await __checkPause())) {
        console.log(
          `[Instagram GraphQL] Pause requested — stopping at cycle ${cycleCount} (${totalCollected} collected)`,
        );
        break;
      }

      cycleCount++;

      console.log(
        `\n[Instagram GraphQL] ── Cycle #${cycleCount} ─────────────────────────────────────────`,
      );
      console.log(
        `[Instagram GraphQL] Request #${cycleCount}: Fetching ${GRAPHQL_BATCH_SIZE} ${type}...`,
      );

      // ── STEP 1: Fetch 100 from GraphQL ─────────────────────────────────────
      let pageData;
      try {
        pageData = await fetchGraphQLPage({
          graphqlUrl,
          queryHash,
          userId,
          afterCursor,
          cookieString,
          csrftoken,
          type,
        });
        consecutiveFailures = 0;
      } catch (fetchErr) {
        consecutiveFailures++;
        console.error(
          `[Instagram GraphQL] Cycle #${cycleCount} fetch failed (consecutive failures: ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`,
          fetchErr.message,
        );

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(
            `[Instagram GraphQL] Aborting — reached ${MAX_CONSECUTIVE_FAILURES} consecutive failures`,
          );
          break;
        }

        await humanDelay(5_000, 10_000);
        continue;
      }

      // Deduplicate within the run
      const newUsers = [];
      for (const edge of pageData.edges) {
        const n = edge.node;
        if (n?.username && !seenUsernames.has(n.username)) {
          seenUsernames.add(n.username);
          newUsers.push({
            id: n.id,
            username: n.username,
            full_name: n.full_name || null,
            profile_pic_url: n.profile_pic_url || null,
            is_verified: n.is_verified || false,
            is_private: n.is_private || false,
          });
        }
      }

      hasNextPage = pageData.hasNextPage;
      afterCursor = pageData.endCursor;

      const cachedCount = seenUsernames.size - newUsers.length;
      console.log(
        `[Instagram GraphQL] Collected ${totalCollected + newUsers.length} new users so far` +
          (totalOnProfile ? ` (need ${totalOnProfile.toLocaleString()}, cached ${cachedCount} already)` : "") +
          `...`,
      );

      if (newUsers.length === 0) {
        console.log(`[Instagram GraphQL] Cycle #${cycleCount}: all users already seen — skipping`);
        if (!hasNextPage) break;
        await humanDelay(...INTER_CYCLE_DELAY);
        continue;
      }

      // ── STEP 2: Apify enrichment for this cycle's batch ───────────────────
      let enrichedUsers;
      try {
        console.log(
          `[Instagram GraphQL] Cycle #${cycleCount}: enriching ${newUsers.length} profiles via Apify...`,
        );
        const apifyResults = await scrapeWithApifyBulk(
          newUsers.map((u) => u.username),
        );
        const apifyMap = new Map(
          apifyResults.map((r) => [r.username?.toLowerCase(), r]),
        );

        enrichedUsers = newUsers.map((user) => {
          const a = apifyMap.get(user.username.toLowerCase());
          return {
            id: user.id,
            username: user.username,
            full_name: a?.fullName || user.full_name,
            followers: a?.followersCount ?? null,
            following: a?.followsCount ?? null,
            bio: a?.biography || null,
            category: a?.businessCategoryName || null,
            avatar: a?.profilePicUrlHD || a?.profilePicUrl || user.profile_pic_url,
            is_verified: a?.verified ?? user.is_verified,
            is_private: a?.private ?? user.is_private,
            external_url: a?.externalUrl || null,
            posts_count: a?.postsCount ?? null,
          };
        });

        console.log(
          `[Instagram GraphQL] Cycle #${cycleCount}: Apify enriched ${enrichedUsers.length} profiles`,
        );
      } catch (apifyErr) {
        console.warn(
          `[Instagram GraphQL] Cycle #${cycleCount}: Apify failed — falling back to GraphQL data. ${apifyErr.message}`,
        );
        enrichedUsers = newUsers.map((user) => ({
          id: user.id,
          username: user.username,
          full_name: user.full_name,
          followers: null,
          following: null,
          bio: null,
          category: null,
          avatar: user.profile_pic_url,
          is_verified: user.is_verified,
          is_private: user.is_private,
          external_url: null,
          posts_count: null,
        }));
      }

      // ── STEP 3: Deep scan external URLs (concurrent, bounded) ─────────────
      const usersWithUrl = enrichedUsers.filter((u) => u.external_url).length;
      console.log(
        `[Instagram GraphQL] Cycle #${cycleCount}: deferring ${usersWithUrl} external URL deep scans until after save`,
      );

      const deepScannedUsers = await deepScanBatch(enrichedUsers);

      // ── STEP 4: Save this cycle's batch to DB immediately ─────────────────
      const leadsToInsert = deepScannedUsers.map((user) =>
        buildLeadDoc({ user, type, targetUsername, folder_id, user_id }),
      );

      let cycleInserted = [];
      let reservedCredits = 0;

      try {
        reservedCredits = await reserveScrapedProfileCredits(
          user_id,
          leadsToInsert.length,
        );

        try {
          cycleInserted = await Lead.insertMany(leadsToInsert, {
            ordered: false,
          });
        } catch (insertErr) {
          if (insertErr.insertedDocs) {
            cycleInserted = insertErr.insertedDocs;
            console.warn(
              `[Instagram GraphQL] Cycle #${cycleCount}: partial insert — ${cycleInserted.length}/${leadsToInsert.length} saved`,
            );
          } else {
            throw insertErr;
          }
        }

        await refundUnusedScrapedProfileCredits(
          user_id,
          reservedCredits,
          cycleInserted.length,
        );

        if (DEEP_SCAN_RELATIONSHIP_ENABLED) {
          const scanTargets = cycleInserted
            .map((lead) => ({
              lead_id: lead?._id,
              url: lead?.external_url || lead?.external_urls?.[0] || null,
            }))
            .filter((target) => target.lead_id && target.url);

          enqueueDeepScanBatch({
            user_id,
            lead_ids: scanTargets.map((target) => target.lead_id),
            urls: scanTargets.map((target) => target.url),
            job_id: null,
          }).catch((error) => {
            console.warn(
              `[Instagram GraphQL] Deep scan enqueue failed: ${error.message}`,
            );
          });
        }

        totalInserted += cycleInserted.length;
        console.log(
          `[Instagram GraphQL] Cycle #${cycleCount}: ✅ saved ${cycleInserted.length} leads (total inserted: ${totalInserted})`,
        );
      } catch (dbErr) {
        if (dbErr.statusCode) throw dbErr;
        console.error(
          `[Instagram GraphQL] Cycle #${cycleCount}: DB save failed — ${dbErr.message}`,
        );
        await refundUnusedScrapedProfileCredits(user_id, reservedCredits, 0).catch(
          () => {},
        );
      }

      totalCollected += newUsers.length;

      if (!hasNextPage || totalCollected >= maxLimit) {
        console.log(
          `[Instagram GraphQL] ${!hasNextPage ? "End of list reached" : `maxLimit of ${maxLimit} reached"}`}`,
        );
        break;
      }

      // Humanized inter-cycle delay
      await humanDelay(...INTER_CYCLE_DELAY);
    }

    // ── Summary ─────────────────────────────────────────────────────────────
    console.log(
      `\n[Instagram GraphQL] ════════════════════════════════════════════════════`,
    );
    console.log(
      `[Instagram GraphQL] Complete: ${cycleCount} cycles | ${totalCollected} collected | ${totalInserted} inserted`,
    );
    console.log(
      `[Instagram GraphQL] ════════════════════════════════════════════════════`,
    );

    await accountPool.releaseAccount(igAccount._id, true);
    console.log(
      `[Instagram GraphQL] Released account: @${igAccount.username} (success)`,
    );

    return {
      code: 200,
      success: true,
      message: `${type}-scraped-successfully-graphql`,
      data: {
        target_username: targetUsername,
        type,
        count: totalCollected,
        enriched_count: totalCollected,
        leads_inserted: totalInserted,
        total_on_profile: totalOnProfile,
        max_limit: maxLimit,
        cycles_run: cycleCount,
        completion_percentage:
          maxLimit > 0 ? Math.round((totalCollected / maxLimit) * 100) : 100,
        status_message: `Scraped ${totalCollected} ${type} in ${cycleCount} cycles`,
        scraping_method: "GraphQL (Cycle-Based)",
      },
    };
  } catch (error) {
    console.error(`[Instagram GraphQL] Fatal error:`, error);

    if (igAccount) {
      const isRateLimit =
        error.message?.toLowerCase().includes("rate limit") ||
        error.message?.toLowerCase().includes("429") ||
        error.message?.toLowerCase().includes("too many requests");

      await accountPool.releaseAccount(
        igAccount._id,
        false,
        isRateLimit ? "rate_limit" : "scraping_error",
      );
      console.log(
        `[Instagram GraphQL] Released account: @${igAccount.username} (failure)`,
      );
    }

    return {
      code: 500,
      success: false,
      message: `failed-to-scrape-${type}-graphql`,
      error: error.message,
      error_type: error.name || "UnknownError",
    };
  }
};
