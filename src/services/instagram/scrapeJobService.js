import ScrapeJob from "../../models/scrapeJob.model.js";
import { normalizeInstagramUsername } from "./normalizers.js";
import { SCRAPE_JOB_STAGES, SCRAPE_JOB_STATUSES } from "./providers/providerTypes.js";

export const createScrapeJob = async ({
  userId,
  folderId = null,
  targetUsername = null,
  scrapeType,
  requestedLimit = 0,
  effectiveLimit = requestedLimit,
  provider = null,
  costBudgetUsd = 0,
  idempotencyKey = null,
}) => {
  const payload = {
    user_id: userId,
    folder_id: folderId,
    target_username: targetUsername ? normalizeInstagramUsername(targetUsername) : null,
    scrape_type: scrapeType,
    requested_limit: requestedLimit,
    effective_limit: effectiveLimit,
    provider,
    cost_budget_usd: costBudgetUsd,
    status: SCRAPE_JOB_STATUSES.QUEUED,
    stage: SCRAPE_JOB_STAGES.VALIDATING,
    idempotency_key: idempotencyKey,
  };

  if (idempotencyKey) {
    return ScrapeJob.findOneAndUpdate(
      { idempotency_key: idempotencyKey },
      { $setOnInsert: payload },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }

  return ScrapeJob.create(payload);
};

export const transitionScrapeJob = async (
  jobId,
  {
    status,
    stage,
    counts = {},
    cursor,
    provider,
    fallbackProvider,
    error,
    finished = false,
  } = {},
) => {
  const set = {};

  if (status) set.status = status;
  if (stage) set.stage = stage;
  if (cursor !== undefined) set.cursor = cursor;
  if (provider !== undefined) set.provider = provider;
  if (fallbackProvider !== undefined) set.fallback_provider = fallbackProvider;
  if (error) {
    set.error_type = error.name || "ScrapeJobError";
    set.error_message = error.message || String(error);
  }
  if (status === SCRAPE_JOB_STATUSES.RUNNING) {
    set.started_at = new Date();
  }
  if (finished || stage === SCRAPE_JOB_STAGES.COMPLETED) {
    set.finished_at = new Date();
  }

  const inc = {};
  for (const [key, value] of Object.entries(counts)) {
    const numericValue = Number(value);
    if (Number.isFinite(numericValue) && numericValue !== 0) {
      inc[key] = numericValue;
    }
  }

  return ScrapeJob.findByIdAndUpdate(
    jobId,
    {
      ...(Object.keys(set).length ? { $set: set } : {}),
      ...(Object.keys(inc).length ? { $inc: inc } : {}),
    },
    { new: true },
  );
};

export const markStuckJobsPartial = async ({ olderThanMs = 60 * 60 * 1000 } = {}) => {
  const cutoff = new Date(Date.now() - olderThanMs);
  return ScrapeJob.updateMany(
    {
      status: { $in: [SCRAPE_JOB_STATUSES.RUNNING, SCRAPE_JOB_STATUSES.CANCEL_REQUESTED] },
      updated_at: { $lt: cutoff },
    },
    {
      $set: {
        status: SCRAPE_JOB_STATUSES.PARTIAL,
        error_type: "StuckJobTimeout",
        error_message: "Job stopped updating before reaching a terminal state.",
        finished_at: new Date(),
      },
    },
  );
};

export default {
  createScrapeJob,
  transitionScrapeJob,
  markStuckJobsPartial,
};

