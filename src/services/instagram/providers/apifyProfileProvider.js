import mongoose from "mongoose";
import { ApifyClient } from "apify-client";
import { instagramConfig, requireApifyConfig } from "../../../config/instagram.js";
import ApifyRun from "../../../models/apifyRun.model.js";
import logger from "../../../utils/logger.js";
import {
  ProviderCostLimitError,
  ProviderEmptyResultError,
  ProviderInvalidInputError,
  classifyProviderError,
} from "../errors.js";
import { normalizeInstagramProfile, normalizeInstagramUsername } from "../normalizers.js";
import { sanitizeForLog } from "../utils/logSanitizer.js";
import { ProviderCircuitBreaker } from "../utils/circuitBreaker.js";
import { withRetry, withTimeout } from "../utils/retry.js";
import { APIFY_RUN_STATUSES, PROFILE_PROVIDER_TYPES } from "./providerTypes.js";

let apifyClient = null;

const toObjectIdOrNull = (value) =>
  mongoose.Types.ObjectId.isValid(value) ? new mongoose.Types.ObjectId(value) : null;

export const getApifyClient = () => {
  const config = requireApifyConfig();
  if (!apifyClient) {
    apifyClient = new ApifyClient({ token: config.token });
  }
  return apifyClient;
};

export const resetApifyClientForTests = () => {
  apifyClient = null;
};

export const normalizeAndDedupeUsernames = (usernames) => {
  const inputs = Array.isArray(usernames) ? usernames : [usernames];
  const normalized = [];
  const seen = new Set();

  for (const input of inputs) {
    const username = normalizeInstagramUsername(input);
    if (!seen.has(username)) {
      normalized.push(username);
      seen.add(username);
    }
  }

  return normalized;
};

export const chunkUsernames = (usernames, chunkSize) => {
  const size = Math.max(1, Number.parseInt(chunkSize, 10) || 1);
  const chunks = [];
  for (let i = 0; i < usernames.length; i += size) {
    chunks.push(usernames.slice(i, i + size));
  }
  return chunks;
};

export const buildApifyInstagramProfileInput = (usernames) => ({
  usernames: usernames.map((username) => `https://www.instagram.com/${username}/`),
});

export const estimateApifyProfileCostUsd = (
  inputCount,
  estimatedProfileCostUsd = instagramConfig.apify.estimatedProfileCostUsd,
) => Number((Math.max(0, inputCount) * estimatedProfileCostUsd).toFixed(6));

export const assertApifyCostBudget = ({
  inputCount,
  maxCostUsd = instagramConfig.apify.maxCostUsdPerJob,
  estimatedProfileCostUsd = instagramConfig.apify.estimatedProfileCostUsd,
}) => {
  const estimatedCost = estimateApifyProfileCostUsd(inputCount, estimatedProfileCostUsd);
  if (maxCostUsd > 0 && estimatedCost > maxCostUsd) {
    throw new ProviderCostLimitError("apify-profile-cost-budget-exceeded", {
      provider: PROFILE_PROVIDER_TYPES.APIFY,
      metadata: { input_count: inputCount, estimated_cost: estimatedCost, max_cost_usd: maxCostUsd },
    });
  }
  return estimatedCost;
};

export const fetchAllApifyDatasetItems = async (
  datasetId,
  {
    client = getApifyClient(),
    pageSize = instagramConfig.apify.datasetPageSize,
    maxItems = Number.MAX_SAFE_INTEGER,
  } = {},
) => {
  if (!datasetId) {
    throw new ProviderInvalidInputError("apify-dataset-id-required", {
      provider: PROFILE_PROVIDER_TYPES.APIFY,
    });
  }

  const safePageSize = Math.max(1, Math.min(Number(pageSize) || 100, 1000));
  const safeMaxItems = Math.max(0, Number(maxItems) || 0);
  const items = [];
  let offset = 0;
  let total = null;
  let truncated = false;

  while (items.length < safeMaxItems) {
    const remaining = safeMaxItems - items.length;
    const limit = Math.min(safePageSize, remaining);
    if (limit <= 0) break;

    const page = await client.dataset(datasetId).listItems({
      offset,
      limit,
      clean: true,
    });

    const pageItems = Array.isArray(page?.items) ? page.items : [];
    if (typeof page?.total === "number") total = page.total;

    items.push(...pageItems);
    offset += pageItems.length;

    if (pageItems.length < limit) break;
    if (total !== null && offset >= total) break;
  }

  if (total !== null && items.length < total) {
    truncated = items.length >= safeMaxItems;
  }

  return {
    items,
    total,
    fetched: items.length,
    truncated,
  };
};

const createRunAudit = async ({
  jobId,
  userId,
  actorId,
  inputCount,
  chunkIndex,
  chunkSize,
  estimatedCost,
  maxCostUsd,
  status = APIFY_RUN_STATUSES.CREATED,
  metadata = {},
}) => {
  try {
    return await ApifyRun.create({
      job_id: toObjectIdOrNull(jobId),
      user_id: toObjectIdOrNull(userId),
      provider: PROFILE_PROVIDER_TYPES.APIFY,
      actor_id: actorId,
      input_count: inputCount,
      chunk_index: chunkIndex,
      chunk_size: chunkSize,
      estimated_cost: estimatedCost,
      max_cost_usd: maxCostUsd,
      status,
      metadata: {
        ...metadata,
        external_job_id: jobId && !toObjectIdOrNull(jobId) ? String(jobId) : undefined,
      },
    });
  } catch (error) {
    logger.warn(
      sanitizeForLog({
        event: "apify_run_audit_create_failed",
        error: error.message,
        job_id: jobId,
        chunk_index: chunkIndex,
      }),
    );
    return null;
  }
};

const updateRunAudit = async (auditId, patch) => {
  if (!auditId) return null;

  try {
    return await ApifyRun.findByIdAndUpdate(
      auditId,
      {
        $set: {
          ...patch,
          last_checked_at: new Date(),
        },
      },
      { new: true },
    );
  } catch (error) {
    logger.warn(
      sanitizeForLog({
        event: "apify_run_audit_update_failed",
        audit_id: auditId,
        error: error.message,
      }),
    );
    return null;
  }
};

const assertConcurrencyLimit = async ({ userId }) => {
  try {
    const [globalRunning, userRunning] = await Promise.all([
      ApifyRun.countDocuments({ status: APIFY_RUN_STATUSES.RUNNING }),
      userId && toObjectIdOrNull(userId)
        ? ApifyRun.countDocuments({
            user_id: toObjectIdOrNull(userId),
            status: APIFY_RUN_STATUSES.RUNNING,
          })
        : Promise.resolve(0),
    ]);

    if (globalRunning >= instagramConfig.apify.maxConcurrentRunsGlobal) {
      throw new ProviderCostLimitError("apify-global-concurrency-limit-reached", {
        provider: PROFILE_PROVIDER_TYPES.APIFY,
        metadata: { global_running: globalRunning },
      });
    }
    if (userRunning >= instagramConfig.apify.maxConcurrentRunsPerUser) {
      throw new ProviderCostLimitError("apify-user-concurrency-limit-reached", {
        provider: PROFILE_PROVIDER_TYPES.APIFY,
        metadata: { user_running: userRunning },
      });
    }
  } catch (error) {
    if (error instanceof ProviderCostLimitError) throw error;
    logger.warn(
      sanitizeForLog({
        event: "apify_concurrency_check_failed",
        error: error.message,
      }),
    );
  }
};

const mapApifyItemsToResults = ({ items, usernames, run, datasetFetch, chunkIndex }) => {
  const wanted = new Set(usernames.map((username) => username.toLowerCase()));
  const results = [];

  for (const item of items) {
    const profile = normalizeInstagramProfile(item, PROFILE_PROVIDER_TYPES.APIFY);
    if (!profile.username || !wanted.has(profile.username.toLowerCase())) continue;

    results.push({
      provider: PROFILE_PROVIDER_TYPES.APIFY,
      source: PROFILE_PROVIDER_TYPES.APIFY,
      success: true,
      username: profile.username,
      profile,
      raw: item,
      run_id: run?.id || null,
      dataset_id: run?.defaultDatasetId || null,
      chunk_index: chunkIndex,
      dataset: datasetFetch,
    });
  }

  const found = new Set(results.map((result) => result.username.toLowerCase()));
  for (const username of usernames) {
    if (!found.has(username.toLowerCase())) {
      results.push({
        provider: PROFILE_PROVIDER_TYPES.APIFY,
        source: PROFILE_PROVIDER_TYPES.APIFY,
        success: false,
        username,
        error_type: "ProviderEmptyResultError",
        error_message: "apify-returned-no-profile-for-username",
        run_id: run?.id || null,
        dataset_id: run?.defaultDatasetId || null,
        chunk_index: chunkIndex,
      });
    }
  }

  return results;
};

export class ApifyProfileProvider {
  provider = PROFILE_PROVIDER_TYPES.APIFY;
  capabilities = {
    provider: PROFILE_PROVIDER_TYPES.APIFY,
    supportsFollowers: false,
    supportsFollowing: false,
    supportsCursorResume: false,
    supportsProfileEnrichment: true,
  };

  constructor({
    client = null,
    config = instagramConfig.apify,
    runModel = ApifyRun,
    circuitBreaker = null,
  } = {}) {
    this.client = client;
    this.config = config;
    this.runModel = runModel;
    this.circuitBreaker =
      circuitBreaker ||
      new ProviderCircuitBreaker({
        provider: PROFILE_PROVIDER_TYPES.APIFY,
        failureThreshold: config.circuitBreakerFailureThreshold,
        cooldownMs: config.circuitBreakerCooldownMs,
      });
  }

  getClient() {
    return this.client || getApifyClient();
  }

  async enrichProfile(username, options = {}) {
    const results = await this.enrichProfiles([username], options);
    const result = results.find((entry) => entry.success);
    if (!result) {
      throw new ProviderEmptyResultError("apify-profile-empty-result", {
        provider: PROFILE_PROVIDER_TYPES.APIFY,
        metadata: { username },
      });
    }
    return result;
  }

  async enrichProfiles(usernames, options = {}) {
    const normalized = normalizeAndDedupeUsernames(usernames);
    if (normalized.length === 0) {
      throw new ProviderInvalidInputError("apify-profile-usernames-required", {
        provider: PROFILE_PROVIDER_TYPES.APIFY,
      });
    }

    const maxCostUsd = options.maxCostUsd ?? this.config.maxCostUsdPerJob;
    const estimatedCost = assertApifyCostBudget({
      inputCount: normalized.length,
      maxCostUsd,
      estimatedProfileCostUsd: this.config.estimatedProfileCostUsd,
    });

    const chunkSize = Math.min(
      options.chunkSize || this.config.maxProfileChunkSize,
      this.config.maxProfileChunkSize,
    );
    const chunks = chunkUsernames(normalized, chunkSize);
    const results = [];

    for (let index = 0; index < chunks.length; index++) {
      const chunkResults = await this.#runSmallChunk(chunks[index], {
        ...options,
        chunkIndex: options.startChunkIndex !== undefined ? options.startChunkIndex + index : index,
        maxCostUsd,
        estimatedCost: estimateApifyProfileCostUsd(
          chunks[index].length,
          this.config.estimatedProfileCostUsd,
        ),
      });
      results.push(...chunkResults);
    }

    logger.info(
      sanitizeForLog({
        event: "apify_profile_enrichment_finished",
        provider: PROFILE_PROVIDER_TYPES.APIFY,
        input_count: normalized.length,
        output_count: results.filter((result) => result.success).length,
        estimated_cost: estimatedCost,
      }),
    );

    return results;
  }

  async startProfileEnrichmentRuns(usernames, options = {}) {
    const normalized = normalizeAndDedupeUsernames(usernames);
    const maxCostUsd = options.maxCostUsd ?? this.config.maxCostUsdPerJob;
    assertApifyCostBudget({
      inputCount: normalized.length,
      maxCostUsd,
      estimatedProfileCostUsd: this.config.estimatedProfileCostUsd,
    });

    await assertConcurrencyLimit({ userId: options.userId });

    const chunkSize = Math.min(
      options.chunkSize || this.config.maxProfileChunkSizeLarge,
      this.config.maxProfileChunkSizeLarge,
    );
    const chunks = chunkUsernames(normalized, chunkSize);
    const actorId = options.actorId || this.config.actorId;
    const startedRuns = [];

    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index];
      const chunkIndex =
        options.startChunkIndex !== undefined ? options.startChunkIndex + index : index;
      const estimatedCost = estimateApifyProfileCostUsd(
        chunk.length,
        this.config.estimatedProfileCostUsd,
      );
      const audit = await createRunAudit({
        jobId: options.jobId,
        userId: options.userId,
        actorId,
        inputCount: chunk.length,
        chunkIndex,
        chunkSize: chunk.length,
        estimatedCost,
        maxCostUsd,
      });

      const run = await withTimeout(
        this.getClient().actor(actorId).start(buildApifyInstagramProfileInput(chunk)),
        this.config.externalCallTimeoutMs,
        "apify-start-timeout",
      );

      await updateRunAudit(audit?._id, {
        status: APIFY_RUN_STATUSES.RUNNING,
        run_id: run?.id || null,
        dataset_id: run?.defaultDatasetId || null,
        started_at: new Date(),
      });

      startedRuns.push({
        provider: PROFILE_PROVIDER_TYPES.APIFY,
        actor_id: actorId,
        run_id: run?.id || null,
        dataset_id: run?.defaultDatasetId || null,
        chunk_index: chunkIndex,
        input_count: chunk.length,
        status: APIFY_RUN_STATUSES.RUNNING,
      });
    }

    return startedRuns;
  }

  async #runSmallChunk(usernames, options = {}) {
    this.circuitBreaker.assertCanCall();

    const actorId = options.actorId || this.config.actorId;
    const audit = await createRunAudit({
      jobId: options.jobId,
      userId: options.userId,
      actorId,
      inputCount: usernames.length,
      chunkIndex: options.chunkIndex || 0,
      chunkSize: usernames.length,
      estimatedCost: options.estimatedCost,
      maxCostUsd: options.maxCostUsd ?? this.config.maxCostUsdPerJob,
    });

    const input = buildApifyInstagramProfileInput(usernames);

    logger.info(
      sanitizeForLog({
        event: "apify_profile_chunk_started",
        provider: PROFILE_PROVIDER_TYPES.APIFY,
        actor_id: actorId,
        job_id: options.jobId,
        user_id: options.userId,
        chunk_index: options.chunkIndex || 0,
        input_count: usernames.length,
      }),
    );

    try {
      const run = await withRetry(
        async () =>
          withTimeout(
            this.getClient().actor(actorId).call(input, {
              waitSecs: options.waitSecs || this.config.callWaitSecs,
            }),
            options.timeoutMs || this.config.externalCallTimeoutMs,
            "apify-call-timeout",
          ),
        {
          attempts: options.maxRetries ?? this.config.maxRetries,
          baseDelayMs: this.config.retryBaseDelayMs,
          maxDelayMs: this.config.retryMaxDelayMs,
          provider: PROFILE_PROVIDER_TYPES.APIFY,
          onRetry: async ({ error, attempt, delayMs }) => {
            await updateRunAudit(audit?._id, {
              retry_count: attempt,
              error_type: error.name,
              error_message: error.message,
            });
            logger.warn(
              sanitizeForLog({
                event: "apify_profile_chunk_retry",
                chunk_index: options.chunkIndex || 0,
                attempt,
                delay_ms: delayMs,
                error_type: error.name,
                error_message: error.message,
              }),
            );
          },
        },
      );

      const datasetFetch = await fetchAllApifyDatasetItems(run.defaultDatasetId, {
        client: this.getClient(),
        pageSize: options.pageSize || this.config.datasetPageSize,
        maxItems: options.maxItems || usernames.length,
      });

      if (!datasetFetch.items.length) {
        throw new ProviderEmptyResultError("apify-profile-empty-dataset", {
          provider: PROFILE_PROVIDER_TYPES.APIFY,
          metadata: { run_id: run?.id, dataset_id: run?.defaultDatasetId },
        });
      }

      const results = mapApifyItemsToResults({
        items: datasetFetch.items,
        usernames,
        run,
        datasetFetch,
        chunkIndex: options.chunkIndex || 0,
      });

      const successfulCount = results.filter((result) => result.success).length;
      await updateRunAudit(audit?._id, {
        status:
          successfulCount === usernames.length
            ? APIFY_RUN_STATUSES.SUCCEEDED
            : APIFY_RUN_STATUSES.PARTIAL,
        run_id: run?.id || null,
        dataset_id: run?.defaultDatasetId || null,
        output_count: successfulCount,
        finished_at: new Date(),
      });

      this.circuitBreaker.recordSuccess();
      return results;
    } catch (error) {
      const classified = classifyProviderError(error, PROFILE_PROVIDER_TYPES.APIFY);
      this.circuitBreaker.recordFailure(classified);

      await updateRunAudit(audit?._id, {
        status:
          classified.name === "ProviderTimeoutError"
            ? APIFY_RUN_STATUSES.TIMED_OUT
            : APIFY_RUN_STATUSES.FAILED,
        error_type: classified.name,
        error_message: classified.message,
        finished_at: new Date(),
      });

      logger.error(
        sanitizeForLog({
          event: "apify_profile_chunk_failed",
          provider: PROFILE_PROVIDER_TYPES.APIFY,
          actor_id: actorId,
          job_id: options.jobId,
          chunk_index: options.chunkIndex || 0,
          error_type: classified.name,
          error_message: classified.message,
        }),
      );

      throw classified;
    }
  }
}

export const apifyProfileProvider = new ApifyProfileProvider();

export default apifyProfileProvider;
