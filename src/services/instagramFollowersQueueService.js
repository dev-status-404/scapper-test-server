import createError from "http-errors";
import InstagramService from "./instagram/index.js";
import { buildRelationshipScrapeJobId } from "./instagram/relationshipJobUtils.js";
import {
  normalizeRelationshipRequestType,
  toRelationshipDirection,
} from "./instagram/relationshipTypes.js";
import {
  bindErrorContext,
  captureException,
  withMonitoringSpan,
} from "../monitoring/index.js";
import { getIO } from "../websockets/index.js";
import { InMemoryJobQueue } from "../utils/inMemoryJobQueue.js";

// const redisConnection = {
//   host: process.env.REDIS_HOST || "127.0.0.1",
//   port: parseInt(process.env.REDIS_PORT || "6379", 10),
//   ...(process.env.REDIS_PASSWORD
//     ? { password: process.env.REDIS_PASSWORD }
//     : {}),
// };
const FOLLOWERS_QUEUE_NAME = "instagram-followers-scrape";
const TERMINAL_JOB_STATES = new Set(["completed", "failed"]);
const PAUSABLE_JOB_STATES = new Set(["waiting", "delayed", "prioritized"]);
const PAUSED_DELAY_MS = parseInt(
  process.env.INSTAGRAM_FOLLOWERS_PAUSED_DELAY_MS || `${24 * 60 * 60 * 1000}`,
  10,
);
const FOLLOWERS_JOB_ATTEMPTS = parseInt(
  process.env.INSTAGRAM_FOLLOWERS_JOB_ATTEMPTS || "5",
  10,
);
const FOLLOWERS_JOB_BACKOFF_MS = parseInt(
  process.env.INSTAGRAM_FOLLOWERS_JOB_BACKOFF_MS || `${5 * 60 * 1000}`,
  10,
);
const FOLLOWERS_WORKER_CONCURRENCY = parseInt(
  process.env.INSTAGRAM_FOLLOWERS_WORKER_CONCURRENCY || "2",
  10,
);
const FOLLOWERS_WORKER_LIMIT_MAX = parseInt(
  process.env.INSTAGRAM_FOLLOWERS_WORKER_LIMIT_MAX ||
    String(FOLLOWERS_WORKER_CONCURRENCY),
  10,
);
const FOLLOWERS_WORKER_LIMIT_DURATION_MS = parseInt(
  process.env.INSTAGRAM_FOLLOWERS_WORKER_LIMIT_DURATION_MS || "1000",
  10,
);
const FOLLOWERS_WORKER_RATE_LIMIT_ENABLED =
  process.env.INSTAGRAM_FOLLOWERS_WORKER_RATE_LIMIT_ENABLED === "true";
const FOLLOWERS_PAUSE_CHECK_TTL_MS = Math.max(
  0,
  parseInt(process.env.INSTAGRAM_FOLLOWERS_PAUSE_CHECK_TTL_MS || "2000", 10),
);

export const instagramFollowersQueue = new InMemoryJobQueue(FOLLOWERS_QUEUE_NAME, {
  defaultJobOptions: {
    attempts: FOLLOWERS_JOB_ATTEMPTS,
    backoff: {
      type: "exponential",
      delay: FOLLOWERS_JOB_BACKOFF_MS,
      jitter: 0.35,
    },
    removeOnComplete: {
      age: parseInt(
        process.env.INSTAGRAM_FOLLOWERS_REMOVE_COMPLETE_AGE || "3600", // 1h (was 24h)
        10,
      ),
      count: 50, // keep max 50 completed jobs regardless
    },
    removeOnFail: {
      age: parseInt(
        process.env.INSTAGRAM_FOLLOWERS_REMOVE_FAIL_AGE || `${2 * 86400}`, // 2 days (was 7)
        10,
      ),
      count: 100,
    },
  },
});

const serializeJob = async (job) => {
  if (!job) {
    return null;
  }

  const state = await job.getState();
  const paused = Boolean(job?.data?.__control?.paused);

  return {
    id: job.id,
    name: job.name,
    state,
    progress: job.progress || 0,
    attemptsMade: job.attemptsMade,
    timestamp: job.timestamp,
    processedOn: job.processedOn || null,
    finishedOn: job.finishedOn || null,
    failedReason: job.failedReason || null,
    data: job.data,
    control: {
      paused,
      pausedAt: job?.data?.__control?.pausedAt || null,
      pauseRequested: Boolean(job?.data?.__control?.pauseRequested),
    },
    result: TERMINAL_JOB_STATES.has(state) ? job.returnvalue || null : null,
  };
};

const normalizeUserId = (value) => String(value || "").trim();

const mapJobStateToRealtimeStatus = (state, paused) => {
  if (paused) return state === "active" ? "PAUSING" : "PAUSED";
  if (state === "completed") return "COMPLETED";
  if (state === "failed") return "FAILED";
  if (state === "active") return "RUNNING";
  return "QUEUED";
};

const mapJobStateToRealtimeStage = (state, paused) => {
  if (paused) return state === "active" ? "PAUSING" : "PAUSED";
  if (state === "completed") return "COMPLETED";
  if (state === "failed") return "FAILED";
  if (state === "active") return "RUNNING";
  return "QUEUED";
};

const emitFollowersJobRealtime = ({
  job,
  state,
  status,
  stage,
  reason = null,
  result = null,
  error = null,
  progress,
}) => {
  const userId = normalizeUserId(job?.data?.user_id);
  if (!userId || !job?.id) return;

  const paused = Boolean(job?.data?.__control?.paused);
  const payload = {
    event: "scrape:progress",
    queue: FOLLOWERS_QUEUE_NAME,
    job_id: String(job.id),
    user_id: userId,
    target_username: job?.data?.targetUsername || null,
    type: job?.data?.type || null,
    relationship_type: toRelationshipDirection(job?.data?.type || "followers"),
    provider: job?.data?.provider || null,
    queue_state: state || null,
    status: status || mapJobStateToRealtimeStatus(state, paused),
    stage: stage || mapJobStateToRealtimeStage(state, paused),
    progress: typeof progress === "number" ? progress : job.progress || 0,
    paused,
    pause_requested: Boolean(job?.data?.__control?.pauseRequested),
    reason,
    error,
    result,
  };

  try {
    const io = getIO();
    io.to(`user:${userId}`).emit("scrape:progress", payload);
  } catch (wsError) {
    console.warn(
      `[Instagram Queue] WebSocket emit failed (non-fatal): ${wsError.message}`,
    );
  }
};

const createPauseChecker = (jobId) => {
  let lastCheckedAt = 0;
  let lastPauseRequested = false;
  let inFlightCheck = null;

  return async () => {
    const now = Date.now();

    if (inFlightCheck) {
      return inFlightCheck;
    }

    if (now - lastCheckedAt < FOLLOWERS_PAUSE_CHECK_TTL_MS) {
      return lastPauseRequested;
    }

    inFlightCheck = (async () => {
      const freshJob = await instagramFollowersQueue.getJob(jobId);
      lastPauseRequested = Boolean(freshJob?.data?.__control?.pauseRequested);
      lastCheckedAt = Date.now();
      return lastPauseRequested;
    })();

    try {
      return await inFlightCheck;
    } finally {
      inFlightCheck = null;
    }
  };
};

const assertJobAccess = (job, { userId, isAdmin = false } = {}) => {
  if (!job) {
    throw createError(404, "followers-scrape-job-not-found");
  }

  if (isAdmin) {
    return;
  }

  const ownerId = normalizeUserId(job?.data?.user_id);
  const requestUserId = normalizeUserId(userId);

  if (!ownerId || !requestUserId || ownerId !== requestUserId) {
    throw createError(403, "followers-scrape-job-forbidden");
  }
};

const updateControlData = async (job, controlPatch = {}) => {
  await job.updateData({
    ...(job.data || {}),
    __control: {
      ...(job?.data?.__control || {}),
      ...controlPatch,
    },
  });
};

export const enqueueRelationshipScrapeJob = async (payload) => {
  const requestType = normalizeRelationshipRequestType(payload.type || "followers");
  const jobId = buildRelationshipScrapeJobId({ ...payload, type: requestType });
  const existingJob = await instagramFollowersQueue.getJob(jobId);

  if (existingJob) {
    const existingState = await existingJob.getState();

    if (!TERMINAL_JOB_STATES.has(existingState)) {
      return {
        created: false,
        job: await serializeJob(existingJob),
      };
    }
  }

  const job = await instagramFollowersQueue.add(
    "scrape-followers-or-following",
    {
      targetUsername: payload.targetUsername,
      type: requestType,
      maxLimit: payload.maxLimit,
      user_id: payload.user_id || null,
      folder_id: payload.folder_id || null,
      provider: payload.provider || null,
      withGraphQl:
        payload.provider != null
          ? String(payload.provider).trim().toLowerCase() === "graphql"
          : Boolean(payload.withGraphQl),
    },
    {
      jobId,
    },
  );

  emitFollowersJobRealtime({
    job,
    state: "waiting",
    status: "QUEUED",
    stage: "QUEUED",
    reason: "job-enqueued",
  });

  return {
    created: true,
    job: await serializeJob(job),
  };
};

export const enqueueFollowersScrapeJob = enqueueRelationshipScrapeJob;

export const getFollowersScrapeJobStatus = async (jobId) => {
  const job = await instagramFollowersQueue.getJob(jobId);
  return serializeJob(job);
};

export const getFollowersScrapeJobStatusForUser = async (
  jobId,
  context = {},
) => {
  const job = await instagramFollowersQueue.getJob(jobId);
  assertJobAccess(job, context);
  return serializeJob(job);
};

export const pauseFollowersScrapeJob = async (jobId, context = {}) => {
  const job = await instagramFollowersQueue.getJob(jobId);
  assertJobAccess(job, context);

  const state = await job.getState();

  if (TERMINAL_JOB_STATES.has(state)) {
    return {
      changed: false,
      reason: "followers-scrape-job-terminal",
      job: await serializeJob(job),
    };
  }

  if (state === "active") {
    await updateControlData(job, {
      pauseRequested: true,
      paused: true,
      pausedAt: new Date().toISOString(),
    });
    const updated = await instagramFollowersQueue.getJob(jobId);
    emitFollowersJobRealtime({
      job: updated,
      state,
      status: "PAUSING",
      stage: "PAUSING",
      reason: "followers-scrape-job-pause-requested",
    });
    return {
      changed: true,
      reason: "followers-scrape-job-pause-requested",
      job: await serializeJob(updated),
    };
  }

  if (!PAUSABLE_JOB_STATES.has(state)) {
    throw createError(409, "followers-scrape-job-cannot-pause-in-state");
  }

  await updateControlData(job, {
    paused: true,
    pausedAt: new Date().toISOString(),
  });

  // Ensure paused jobs are delayed so workers don't pick them up immediately.
  if (state !== "delayed") {
    await job.remove();
    const recreated = await instagramFollowersQueue.add(job.name, {
      ...(job.data || {}),
      __control: {
        ...(job?.data?.__control || {}),
        paused: true,
        pausedAt: new Date().toISOString(),
      },
    }, {
      ...job.opts,
      jobId: String(job.id),
      delay: PAUSED_DELAY_MS,
    });

    emitFollowersJobRealtime({
      job: recreated,
      state: "delayed",
      status: "PAUSED",
      stage: "PAUSED",
      reason: "followers-scrape-job-paused",
    });

    return {
      changed: true,
      reason: "followers-scrape-job-paused",
      job: await serializeJob(recreated),
    };
  }

  if (typeof job.changeDelay === "function") {
    await job.changeDelay(PAUSED_DELAY_MS);
  }

  const updated = await instagramFollowersQueue.getJob(jobId);

  emitFollowersJobRealtime({
    job: updated,
    state: "delayed",
    status: "PAUSED",
    stage: "PAUSED",
    reason: "followers-scrape-job-paused",
  });

  return {
    changed: true,
    reason: "followers-scrape-job-paused",
    job: await serializeJob(updated),
  };
};

export const resumeFollowersScrapeJob = async (jobId, context = {}) => {
  const job = await instagramFollowersQueue.getJob(jobId);
  assertJobAccess(job, context);

  const state = await job.getState();

  if (TERMINAL_JOB_STATES.has(state)) {
    return {
      changed: false,
      reason: "followers-scrape-job-terminal",
      job: await serializeJob(job),
    };
  }

  const isPaused = Boolean(job?.data?.__control?.paused);

  if (!isPaused) {
    return {
      changed: false,
      reason: "followers-scrape-job-not-paused",
      job: await serializeJob(job),
    };
  }

  await updateControlData(job, {
    paused: false,
    pausedAt: null,
    pauseRequested: false,
  });

  if (state === "delayed" && typeof job.changeDelay === "function") {
    await job.changeDelay(0);
  }

  const updated = await instagramFollowersQueue.getJob(jobId);

  emitFollowersJobRealtime({
    job: updated,
    state: state === "delayed" ? "waiting" : state,
    status: state === "delayed" ? "QUEUED" : "RUNNING",
    stage: state === "delayed" ? "QUEUED" : "RUNNING",
    reason: "followers-scrape-job-resumed",
  });

  return {
    changed: true,
    reason: "followers-scrape-job-resumed",
    job: await serializeJob(updated),
  };
};

export const deleteFollowersScrapeJob = async (jobId, context = {}) => {
  const job = await instagramFollowersQueue.getJob(jobId);
  assertJobAccess(job, context);

  const state = await job.getState();

  if (state === "active") {
    throw createError(409, "followers-scrape-job-active-cannot-delete");
  }

  emitFollowersJobRealtime({
    job,
    state,
    status: "DELETED",
    stage: "DELETED",
    reason: "followers-scrape-job-deleted",
  });

  await job.remove();

  return {
    changed: true,
    reason: "followers-scrape-job-deleted",
    job: null,
  };
};

export const getFollowersScrapeJobsByUser = async (userId, { page = 1, limit = 20 } = {}) => {
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) return { jobs: [], total: 0 };

  const states = ["active", "waiting", "delayed", "prioritized", "completed", "failed"];
  const allJobs = await instagramFollowersQueue.getJobs(states);

  // Filter to jobs owned by this user
  const userJobs = allJobs.filter(
    (job) => normalizeUserId(job?.data?.user_id) === normalizedUserId,
  );

  // Most-recently-created first
  userJobs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  const total = userJobs.length;
  const start = (page - 1) * limit;
  const paged = userJobs.slice(start, start + limit);

  const serialized = await Promise.all(paged.map(serializeJob));

  return { jobs: serialized, total, page, limit };
};

export const getFollowersQueueDiagnostics = async () => {
  const counts = await instagramFollowersQueue.getJobCounts(
    "active",
    "waiting",
    "delayed",
    "prioritized",
    "completed",
    "failed",
  );

  const activeJobs = await instagramFollowersQueue.getJobs(["active"], 0, 20);
  const waitingJobs = await instagramFollowersQueue.getJobs(["waiting", "delayed", "prioritized"], 0, 20);

  return {
    queue: FOLLOWERS_QUEUE_NAME,
    backend: "memory",
    worker: {
      started: Boolean(followersWorkerInstance),
      concurrency: FOLLOWERS_WORKER_CONCURRENCY,
      rate_limit_enabled: FOLLOWERS_WORKER_RATE_LIMIT_ENABLED,
      limiter_max: FOLLOWERS_WORKER_RATE_LIMIT_ENABLED ? FOLLOWERS_WORKER_LIMIT_MAX : null,
      limiter_duration_ms: FOLLOWERS_WORKER_RATE_LIMIT_ENABLED
        ? FOLLOWERS_WORKER_LIMIT_DURATION_MS
        : null,
    },
    counts,
    active_jobs: await Promise.all(activeJobs.map(serializeJob)),
    queued_jobs: await Promise.all(waitingJobs.map(serializeJob)),
  };
};

let followersWorkerInstance = null;
let followersWorkerListenersBound = false;

export const createInstagramFollowersWorker = () => {
  if (followersWorkerInstance) {
    return followersWorkerInstance;
  }

  console.log(
    JSON.stringify({
      event: "instagram_relationship_worker_starting",
      queue: FOLLOWERS_QUEUE_NAME,
      backend: "memory",
      concurrency: FOLLOWERS_WORKER_CONCURRENCY,
      rate_limit_enabled: FOLLOWERS_WORKER_RATE_LIMIT_ENABLED,
      limiter_max: FOLLOWERS_WORKER_LIMIT_MAX,
      limiter_duration_ms: FOLLOWERS_WORKER_LIMIT_DURATION_MS,
    }),
  );

  followersWorkerInstance = instagramFollowersQueue.setProcessor(
    async (job) => {
      return withMonitoringSpan(
        "queue.instagramRelationship.process",
        {
          op: "queue.process",
          attributes: {
            "queue.name": FOLLOWERS_QUEUE_NAME,
            "queue.job_id": job.id,
            "user.id": job?.data?.user_id || null,
            "target.username": job?.data?.targetUsername || null,
            "instagram.relationship_type": job?.data?.type || null,
            provider: job?.data?.provider || null,
          },
        },
        async () => {
          const checkPause = createPauseChecker(job.id);

          const response = await InstagramService.scrapeFollowersOrFollowing({
            ...job.data,
            job_id: job.id,
            __checkPause: checkPause,
          });

          if (!response?.success) {
            const error = new Error(
              response?.message || "instagram-followers-scrape-failed",
            );
            error.response = response;
            throw error;
          }

          return {
            code: response.code,
            success: response.success,
            message: response.message,
            data: response.data || null,
          };
        },
      );
    },
    {
      concurrency: FOLLOWERS_WORKER_CONCURRENCY,
    },
  );

  if (followersWorkerListenersBound) {
    return followersWorkerInstance;
  }

  followersWorkerListenersBound = true;

  followersWorkerInstance.on("active", (job) => {
    emitFollowersJobRealtime({
      job,
      state: "active",
      status: "RUNNING",
      stage: "RUNNING",
      reason: "followers-scrape-job-started",
    });
    console.log(
      JSON.stringify({
        event: "instagram_relationship_job_active",
        job_id: job.id,
        user_id: job?.data?.user_id || null,
        target_username: job?.data?.targetUsername || null,
        type: job?.data?.type || null,
        provider: job?.data?.provider || null,
      }),
    );
  });

  followersWorkerInstance.on("completed", (job, result) => {
    emitFollowersJobRealtime({
      job,
      state: "completed",
      status: "COMPLETED",
      stage: "COMPLETED",
      reason: "followers-scrape-job-completed",
      result,
    });
    console.log(
      JSON.stringify({
        event: "instagram_relationship_job_completed",
        job_id: job.id,
        user_id: job?.data?.user_id || null,
        target_username: job?.data?.targetUsername || null,
        type: job?.data?.type || null,
        provider: job?.data?.provider || null,
        saved_count:
          result?.data?.leads_inserted ??
          result?.data?.saved_count ??
          result?.data?.leads?.length ??
          null,
      }),
    );
  });

  followersWorkerInstance.on("failed", (job, err) => {
    emitFollowersJobRealtime({
      job,
      state: "failed",
      status: "FAILED",
      stage: "FAILED",
      reason: "followers-scrape-job-failed",
      error: err?.response?.message || err?.message || null,
    });
    console.error(
      JSON.stringify({
        event: "instagram_relationship_job_failed",
        job_id: job?.id || null,
        user_id: job?.data?.user_id || null,
        target_username: job?.data?.targetUsername || null,
        type: job?.data?.type || null,
        provider: job?.data?.provider || null,
        error_message: err?.response?.message || err.message,
      }),
    );
    captureException(
      err,
      bindErrorContext({
        tags: {
          area: "queue",
          queue: FOLLOWERS_QUEUE_NAME,
          event: "job-failed",
          job_id: job?.id || null,
          user_id: job?.data?.user_id || null,
          provider: job?.data?.provider || null,
        },
        extra: {
          target_username: job?.data?.targetUsername || null,
          relationship_type: job?.data?.type || null,
          attempts_made: job?.attemptsMade || 0,
        },
      }),
    );
  });

  return followersWorkerInstance;
};

export const getRelationshipScrapeJobStatus = getFollowersScrapeJobStatus;
export const getRelationshipScrapeJobStatusForUser = getFollowersScrapeJobStatusForUser;
export const pauseRelationshipScrapeJob = pauseFollowersScrapeJob;
export const resumeRelationshipScrapeJob = resumeFollowersScrapeJob;
export const deleteRelationshipScrapeJob = deleteFollowersScrapeJob;
export const getRelationshipScrapeJobsByUser = getFollowersScrapeJobsByUser;
export const createInstagramRelationshipWorker = createInstagramFollowersWorker;
