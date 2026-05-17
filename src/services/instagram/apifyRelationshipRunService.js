import { ApifyClient } from "apify-client";
import createError from "http-errors";
import ApifyRun from "../../models/apifyRun.model.js";
import ScrapeJob from "../../models/scrapeJob.model.js";
import { instagramConfig } from "../../config/instagram.js";
import { getIO } from "../../websockets/index.js";
import { normalizeInstagramUsername, normalizeRelationshipUser } from "./normalizers.js";
import { bulkUpsertRawRelationships } from "./rawRelationshipService.js";
import {
  normalizeRelationshipRequestType,
  toRelationshipDirection,
} from "./relationshipTypes.js";
import { APIFY_RUN_STATUSES, SCRAPE_JOB_STATUSES } from "./providers/providerTypes.js";
import { fetchAllApifyDatasetItems } from "./providers/apifyProfileProvider.js";
import { sanitizeForLog } from "./utils/logSanitizer.js";

let apifyClient = null;

export const getApifyRelationshipClient = () => {
  if (!instagramConfig.apify.token) {
    throw createError(500, "APIFY_API_KEY is required for Apify relationship scraping");
  }
  if (!apifyClient) {
    apifyClient = new ApifyClient({ token: instagramConfig.apify.token });
  }
  return apifyClient;
};

export const resolveApifyRelationshipActorId = (type) => {
  const requestType = normalizeRelationshipRequestType(type);
  const actorId =
    requestType === "followers"
      ? instagramConfig.apify.followersActorId
      : instagramConfig.apify.followingActorId;

  if (!actorId) {
    throw createError(
      400,
      `APIFY_INSTAGRAM_${requestType.toUpperCase()}_ACTOR_ID is not configured`,
    );
  }

  return actorId;
};

const terminalRunStatusMap = {
  SUCCEEDED: SCRAPE_JOB_STATUSES.SUCCEEDED,
  FAILED: SCRAPE_JOB_STATUSES.FAILED,
  TIMED_OUT: "TIMED_OUT",
  ABORTED: SCRAPE_JOB_STATUSES.CANCELLED,
};

export const buildApifyRelationshipInput = ({
  jobId,
  targetUsername,
  type,
  requestedLimit,
}) => {
  const requestType = normalizeRelationshipRequestType(type);
  const normalizedTarget = normalizeInstagramUsername(targetUsername);
  const maxItems = Math.max(1, Number(requestedLimit || 1));

  return {
    targetUsername: normalizedTarget,
    username: normalizedTarget,
    type: requestType,
    relationshipType: requestType,
    maxItems,
    sessionKey: `${jobId}-${normalizedTarget}-${requestType}`,
    proxySession: String(jobId),
  };
};

export const buildApifyRelationshipRunOptions = ({ requestedLimit, costLimitUsd }) => {
  const options = {
    memory: 1024,
    timeout: 3600,
    maxItems: Math.max(1, Number(requestedLimit || 1)),
  };

  if (Number(costLimitUsd) > 0) {
    options.maxTotalChargeUsd = Number(costLimitUsd);
  }

  if (instagramConfig.apify.webhookUrl) {
    options.webhooks = [
      {
        eventTypes: [
          "ACTOR.RUN.SUCCEEDED",
          "ACTOR.RUN.FAILED",
          "ACTOR.RUN.TIMED_OUT",
          "ACTOR.RUN.ABORTED",
        ],
        requestUrl: instagramConfig.apify.webhookUrl,
      },
    ];
  }

  return options;
};

export const canStartApifyRelationshipRun = async ({
  userId,
  targetUsername,
  runModel = ApifyRun,
}) => {
  const normalizedTarget = normalizeInstagramUsername(targetUsername);
  const [globalRunning, userRunning, targetRunning] = await Promise.all([
    runModel.countDocuments({ provider: "apify", status: APIFY_RUN_STATUSES.RUNNING }),
    runModel.countDocuments({
      provider: "apify",
      user_id: userId,
      status: APIFY_RUN_STATUSES.RUNNING,
    }),
    runModel.countDocuments({
      provider: "apify",
      status: APIFY_RUN_STATUSES.RUNNING,
      "metadata.target_username": normalizedTarget,
    }),
  ]);

  return {
    allowed:
      globalRunning < instagramConfig.apify.maxConcurrentRunsGlobal &&
      userRunning < instagramConfig.apify.maxConcurrentRunsPerUser &&
      targetRunning < instagramConfig.apify.maxConcurrentRunsPerTarget,
    globalRunning,
    userRunning,
    targetRunning,
  };
};

export const createApifyRelationshipScrapeJob = async ({
  userId,
  folderId = null,
  targetUsername,
  type = "followers",
  requestedLimit = 100,
  costLimitUsd = instagramConfig.apify.maxCostUsdPerJob,
  jobModel = ScrapeJob,
}) => {
  const requestType = normalizeRelationshipRequestType(type);
  const normalizedTarget = normalizeInstagramUsername(targetUsername);

  const active = await jobModel.findOne({
    user_id: userId,
    target_username: normalizedTarget,
    scrape_type: requestType,
    status: { $in: ["QUEUED", "RUNNING", "PAUSED", "CANCEL_REQUESTED"] },
  });

  if (active) {
    return { created: false, job: active };
  }

  const job = await jobModel.create({
    user_id: userId,
    folder_id: folderId,
    target_username: normalizedTarget,
    scrape_type: requestType,
    type: requestType,
    provider: "apify",
    requested_limit: requestedLimit,
    effective_limit: requestedLimit,
    cost_budget_usd: costLimitUsd,
    cost_limit_usd: costLimitUsd,
    status: SCRAPE_JOB_STATUSES.QUEUED,
    stage: "COLLECTING_RELATIONSHIPS",
  });

  console.log(
    JSON.stringify(
      sanitizeForLog({
        event: "scrape_job_created",
        job_id: String(job._id),
        user_id: String(userId),
        target_username: normalizedTarget,
        type: requestType,
        provider: "apify",
        status: job.status,
      }),
    ),
  );

  return { created: true, job };
};

export const startQueuedApifyRelationshipJob = async ({
  job,
  client = getApifyRelationshipClient(),
  runModel = ApifyRun,
  jobModel = ScrapeJob,
}) => {
  const concurrency = await canStartApifyRelationshipRun({
    userId: job.user_id,
    targetUsername: job.target_username,
    runModel,
  });

  if (!concurrency.allowed) {
    console.log(
      JSON.stringify(
        sanitizeForLog({
          event: "scrape_job_queued",
          job_id: String(job._id),
          user_id: String(job.user_id),
          target_username: job.target_username,
          type: job.scrape_type,
          provider: "apify",
          status: SCRAPE_JOB_STATUSES.QUEUED,
          concurrency,
        }),
      ),
    );
    return { started: false, reason: "apify-concurrency-limit", job };
  }

  const actorId = resolveApifyRelationshipActorId(job.scrape_type);
  const input = buildApifyRelationshipInput({
    jobId: job._id,
    targetUsername: job.target_username,
    type: job.scrape_type,
    requestedLimit: job.requested_limit,
  });
  const options = buildApifyRelationshipRunOptions({
    requestedLimit: job.requested_limit,
    costLimitUsd: job.cost_limit_usd || job.cost_budget_usd,
  });

  const run = await client.actor(actorId).start(input, options);
  const datasetId = run.defaultDatasetId || run.defaultDatasetID || null;

  await runModel.create({
    job_id: job._id,
    user_id: job.user_id,
    provider: "apify",
    actor_id: actorId,
    run_id: run.id,
    dataset_id: datasetId,
    input_count: Number(job.requested_limit || 0),
    status: APIFY_RUN_STATUSES.RUNNING,
    max_cost_usd: job.cost_limit_usd || job.cost_budget_usd || 0,
    started_at: new Date(),
    last_checked_at: new Date(),
    metadata: {
      target_username: job.target_username,
      type: job.scrape_type,
      maxItems: options.maxItems,
    },
  });

  const updatedJob = await jobModel.findByIdAndUpdate(
    job._id,
    {
      $set: {
        status: SCRAPE_JOB_STATUSES.RUNNING,
        provider: "apify",
        apify_run_id: run.id,
        apify_dataset_id: datasetId,
        started_at: new Date(),
      },
    },
    { new: true },
  );

  console.log(
    JSON.stringify(
      sanitizeForLog({
        event: "apify_run_started",
        job_id: String(job._id),
        user_id: String(job.user_id),
        target_username: job.target_username,
        type: job.scrape_type,
        provider: "apify",
        apify_run_id: run.id,
        dataset_id: datasetId,
        status: "RUNNING",
        maxItems: options.maxItems,
      }),
    ),
  );

  return { started: true, job: updatedJob, run };
};

const mapApifyRunStatus = (status) => {
  if (status === "SUCCEEDED") return APIFY_RUN_STATUSES.SUCCEEDED;
  if (status === "TIMED-OUT" || status === "TIMED_OUT") return APIFY_RUN_STATUSES.TIMED_OUT;
  if (status === "ABORTED") return APIFY_RUN_STATUSES.ABORTED;
  if (status === "FAILED") return APIFY_RUN_STATUSES.FAILED;
  return status || APIFY_RUN_STATUSES.RUNNING;
};

export const processApifyRelationshipWebhook = async ({
  payload,
  client = getApifyRelationshipClient(),
  runModel = ApifyRun,
  jobModel = ScrapeJob,
}) => {
  const runId = payload?.resource?.id || payload?.resourceId || payload?.runId || payload?.run_id;
  if (!runId) throw createError(400, "apify-run-id-required");

  const apifyRun = await runModel.findOne({ run_id: runId });
  if (!apifyRun) throw createError(404, "apify-run-not-found");

  if (apifyRun.processed_at) {
    return { idempotent: true, run: apifyRun };
  }

  const job = await jobModel.findById(apifyRun.job_id);
  if (!job) throw createError(404, "scrape-job-not-found");

  console.log(
    JSON.stringify(
      sanitizeForLog({
        event: "apify_webhook_received",
        job_id: String(job._id),
        user_id: String(job.user_id),
        target_username: job.target_username,
        type: job.scrape_type,
        provider: "apify",
        apify_run_id: runId,
      }),
    ),
  );

  const remoteRun = await client.run(runId).get();
  const apifyStatus = mapApifyRunStatus(remoteRun?.status);
  const datasetId = remoteRun?.defaultDatasetId || apifyRun.dataset_id || job.apify_dataset_id;

  const terminalStatuses = new Set([
    APIFY_RUN_STATUSES.SUCCEEDED,
    APIFY_RUN_STATUSES.FAILED,
    APIFY_RUN_STATUSES.TIMED_OUT,
    APIFY_RUN_STATUSES.ABORTED,
  ]);

  if (!terminalStatuses.has(apifyStatus)) {
    await runModel.findByIdAndUpdate(apifyRun._id, {
      $set: { status: apifyStatus, last_checked_at: new Date() },
    });
    return { idempotent: false, terminal: false, status: apifyStatus };
  }

  let fetched = { items: [], fetched: 0, total: 0, truncated: false };
  if (apifyStatus === APIFY_RUN_STATUSES.SUCCEEDED && datasetId) {
    console.log(
      JSON.stringify(
        sanitizeForLog({
          event: "apify_dataset_fetch_started",
          job_id: String(job._id),
          user_id: String(job.user_id),
          target_username: job.target_username,
          type: job.scrape_type,
          provider: "apify",
          apify_run_id: runId,
          dataset_id: datasetId,
        }),
      ),
    );

    fetched = await fetchAllApifyDatasetItems(datasetId, {
      pageSize: instagramConfig.apify.datasetPageSize,
      maxItems: job.requested_limit || 100,
      client,
    });
  }

  const normalizedUsers = fetched.items
    .map((item) => normalizeRelationshipUser(item, "apify"))
    .filter((item) => item.username);

  let rawResult = { upsertedCount: 0, duplicateCount: 0, processed: 0 };
  if (normalizedUsers.length) {
    rawResult = await bulkUpsertRawRelationships({
      jobId: String(job._id),
      userId: job.user_id,
      targetUsername: job.target_username,
      relationshipType: job.scrape_type,
      users: normalizedUsers,
      sourceProvider: "apify",
      cursorPage: { run_id: runId, dataset_id: datasetId },
    });
  }

  const finalJobStatus = terminalRunStatusMap[apifyStatus] || SCRAPE_JOB_STATUSES.FAILED;
  const finishedAt = new Date();

  await runModel.findByIdAndUpdate(apifyRun._id, {
    $set: {
      status: apifyStatus,
      dataset_id: datasetId,
      output_count: normalizedUsers.length,
      finished_at: finishedAt,
      last_checked_at: finishedAt,
      processed_at: finishedAt,
      error_type: remoteRun?.statusMessage ? "ApifyRunError" : null,
      error_message: remoteRun?.statusMessage || null,
    },
  });

  const updatedJob = await jobModel.findByIdAndUpdate(
    job._id,
    {
      $set: {
        status: finalJobStatus,
        stage: finalJobStatus === SCRAPE_JOB_STATUSES.SUCCEEDED ? "COMPLETED" : job.stage,
        apify_dataset_id: datasetId,
        collected_count: normalizedUsers.length,
        saved_count: rawResult.upsertedCount || 0,
        duplicate_count: rawResult.duplicateCount || 0,
        failed_count: finalJobStatus === SCRAPE_JOB_STATUSES.SUCCEEDED ? 0 : 1,
        finished_at: finishedAt,
        error_type: finalJobStatus === SCRAPE_JOB_STATUSES.SUCCEEDED ? null : "ApifyRunError",
        error_message:
          finalJobStatus === SCRAPE_JOB_STATUSES.SUCCEEDED
            ? null
            : remoteRun?.statusMessage || apifyStatus,
      },
    },
    { new: true },
  );

  try {
    getIO().to(`user:${job.user_id}`).emit("scrape:progress", {
      event: "scrape:progress",
      job_id: String(job._id),
      stage: updatedJob.stage,
      status: updatedJob.status,
      provider: "apify",
      target_username: job.target_username,
      relationship_type: toRelationshipDirection(job.scrape_type),
      type: job.scrape_type,
      collected_count: normalizedUsers.length,
      saved_count: rawResult.upsertedCount || 0,
      duplicate_count: rawResult.duplicateCount || 0,
      failed_count: updatedJob.failed_count,
      requested_limit: job.requested_limit,
      partial: updatedJob.status === SCRAPE_JOB_STATUSES.PARTIAL,
      ts: Date.now(),
    });
  } catch {
    // websocket progress is best effort
  }

  console.log(
    JSON.stringify(
      sanitizeForLog({
        event:
          finalJobStatus === SCRAPE_JOB_STATUSES.SUCCEEDED
            ? "scrape_job_finished"
            : "scrape_job_failed",
        job_id: String(job._id),
        user_id: String(job.user_id),
        target_username: job.target_username,
        type: job.scrape_type,
        provider: "apify",
        apify_run_id: runId,
        dataset_id: datasetId,
        status: finalJobStatus,
        collected_count: normalizedUsers.length,
        saved_count: rawResult.upsertedCount || 0,
        duplicate_count: rawResult.duplicateCount || 0,
      }),
    ),
  );

  return { idempotent: false, terminal: true, job: updatedJob };
};

export default {
  createApifyRelationshipScrapeJob,
  startQueuedApifyRelationshipJob,
  processApifyRelationshipWebhook,
  buildApifyRelationshipInput,
  buildApifyRelationshipRunOptions,
  canStartApifyRelationshipRun,
};
