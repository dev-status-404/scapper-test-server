import InstagramService from "../services/instagram/index.js";
import ScrapeJob from "../models/scrapeJob.model.js";
import {
  enqueueFollowersScrapeJob,
  getFollowersScrapeJobStatusForUser,
  getFollowersScrapeJobsByUser,
  pauseFollowersScrapeJob,
  resumeFollowersScrapeJob,
  deleteFollowersScrapeJob,
  getFollowersQueueDiagnostics,
} from "../services/instagramFollowersQueueService.js";
import { toRelationshipDirection } from "../services/instagram/relationshipTypes.js";
import { RELATIONSHIP_PROVIDER_TYPES } from "../services/instagram/providers/providerTypes.js";
import {
  createApifyRelationshipScrapeJob,
  processApifyRelationshipWebhook,
  startQueuedApifyRelationshipJob,
} from "../services/instagram/apifyRelationshipRunService.js";
import { instagramConfig } from "../config/instagram.js";
import { getRemainingCredits } from "../services/scrapeCreditService.js";
import { sendError } from "../utils/errorHelper.js";
import { t } from "../utils/translation.js";

const getRequestContext = (req) => ({
  userId: String(req?.user?._id || ""),
  isAdmin: Boolean(req?.isAdmin),
});

const resolveRelationshipProvider = ({ provider, withGraphQl }) => {
  const normalizedProvider = String(provider || "")
    .trim()
    .toLowerCase();

  if (
    normalizedProvider === RELATIONSHIP_PROVIDER_TYPES.GRAPHQL ||
    normalizedProvider === RELATIONSHIP_PROVIDER_TYPES.PUPPETEER ||
    normalizedProvider === RELATIONSHIP_PROVIDER_TYPES.APIFY
  ) {
    return normalizedProvider;
  }

  if (provider != null && normalizedProvider) {
    return null;
  }

  return withGraphQl
    ? RELATIONSHIP_PROVIDER_TYPES.GRAPHQL
    : RELATIONSHIP_PROVIDER_TYPES.PUPPETEER;
};

const scrapeProfile = async (req, res) => {
  try {
    const { profileUrl, profileUrls, user_id, folder_id } = req.body;

    // Support both single profileUrl and multiple profileUrls
    let urlsToScrape = [];

    if (profileUrls && Array.isArray(profileUrls) && profileUrls.length > 0) {
      urlsToScrape = profileUrls;
    } else if (profileUrl) {
      urlsToScrape = [profileUrl];
    } else {
      return res.status(400).json({
        code: 400,
        success: false,
        message: t('profileUrl or profileUrls is required'),
      });
    }

    // If multiple URLs, use bulk scraping
    if (urlsToScrape.length > 1) {
      const response = await InstagramService.scrapeInstagramBulk({
        profileUrls: urlsToScrape,
        user_id,
        folder_id,
      });

      return res.status(response.code).json({
        code: response.code,
        success: response.success,
        message: response.message,
        data: response.data,
      });
    }

    // Single URL - use existing logic
    const response = await InstagramService.scrapeInstagram({
      profileUrl: urlsToScrape[0],
      user_id,
      folder_id,
    });

    return res.status(response.code).json({
      code: response.code,
      success: response.success,
      message: response.message,
      scraped_with: response.scraped_with,
      data: response.data,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

const deepScan = async (req, res) => {
  try {
    const { externalUrl } = req.body;

    if (!externalUrl) {
      return res.status(400).json({
        code: 400,
        success: false,
        message: t('externalUrl is required'),
      });
    }

    const result = await InstagramService.deepScanExternalUrl(externalUrl);

    return res.status(200).json({
      code: 200,
      success: true,
      message: t('deep-scan-completed'),
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

const scrapeFollowersOrFollowing = async (req, res) => {
  try {
    const {
      targetUsername,
      type = "followers",
      // maxLimit is intentionally ignored — the service scrapes based on the
      // real profile count read from the DOM (totalCount).
      user_id,
      folder_id,
      withGraphQl,
      provider,
    } = req.body;

    if (!targetUsername) {
      return res.status(400).json({
        code: 400,
        success: false,
        message: t('targetUsername is required'),
      });
    }

    const requestType = String(type || "followers").trim().toLowerCase();

    if (!["followers", "following"].includes(requestType)) {
      return res.status(400).json({
        code: 400,
        success: false,
        message: t('type must be either "followers" or "following"'),
      });
    }

    const selectedProvider = resolveRelationshipProvider({
      provider,
      withGraphQl,
    });

    if (!selectedProvider) {
      return res.status(400).json({
        code: 400,
        success: false,
        message: t('provider must be one of "graphql" or "puppeteer"'),
      });
    }

    const effectiveUserId = String(req?.user?._id || user_id || "");

    if (!effectiveUserId) {
      return res.status(400).json({
        code: 400,
        success: false,
        message: t('user_id is required'),
      });
    }

    const remainingCredits = getRemainingCredits(req.subscription);
    if (remainingCredits < 1) {
      return res.status(402).json({
        code: 402,
        success: false,
        message: t(`Insufficient credits to start a scrape job. You have ${remainingCredits} credit(s) remaining.`),
      });
    }

    if (selectedProvider === RELATIONSHIP_PROVIDER_TYPES.APIFY) {
      const { created, job } = await createApifyRelationshipScrapeJob({
        userId: effectiveUserId,
        folderId: folder_id,
        targetUsername,
        type: requestType,
        requestedLimit: Number(req.body.requestedLimit || req.body.maxItems || 100),
      });

      let startResult = { started: false, reason: "already-active" };
      if (created) {
        startResult = await startQueuedApifyRelationshipJob({ job });
      }

      return res.status(202).json({
        code: 202,
        success: true,
        message: created
          ? "instagram-apify-scrape-job-created"
          : "instagram-apify-scrape-job-already-active",
        data: {
          job_id: String(job._id),
          status: startResult.started ? "RUNNING" : job.status,
          stage: job.stage,
          provider: selectedProvider,
          apify_run_id: startResult.run?.id || job.apify_run_id || null,
          type: requestType,
          relationship_type: toRelationshipDirection(requestType),
          target_username: targetUsername,
          requested_limit: job.requested_limit,
          estimated_cost: job.estimated_cost_usd || null,
          queued_reason: startResult.started ? null : startResult.reason,
          progress_url: `/api/beta-insta/scrape-followers/jobs/${job._id}`,
        },
      });
    }

    const queued = await enqueueFollowersScrapeJob({
      targetUsername,
      type: requestType,
      // maxLimit not passed — service uses profile's real totalCount from DOM
      user_id: effectiveUserId,
      withGraphQl: selectedProvider === RELATIONSHIP_PROVIDER_TYPES.GRAPHQL,
      provider: selectedProvider,
      folder_id,
    });

    return res.status(queued.created ? 202 : 200).json({
      code: queued.created ? 202 : 200,
      success: true,
      message: queued.created
        ? "followers-scrape-job-queued"
        : "followers-scrape-job-already-running",
      data: {
        job_id: queued.job?.id,
        status: queued.job?.state,
        stage: queued.created ? "QUEUED" : "RUNNING",
        provider: selectedProvider,
        type: requestType,
        relationship_type: toRelationshipDirection(requestType),
        target_username: targetUsername,
        requested_limit: queued.job?.data?.maxLimit || null,
        estimated_cost: null,
        progress_url: queued.job?.id
          ? `/api/beta-insta/scrape-followers/jobs/${queued.job.id}`
          : null,
        job: queued.job,
      },
    });
  } catch (error) {
    return sendError(res, error);
  }
};

const getFollowersScrapeJob = async (req, res) => {
  try {
    const { jobId } = req.params;

    if (!jobId) {
      return res.status(400).json({
        code: 400,
        success: false,
        message: t('jobId is required'),
      });
    }

    let job = null;
    try {
      job = await getFollowersScrapeJobStatusForUser(jobId, getRequestContext(req));
    } catch (queueError) {
      if (queueError.status !== 404) throw queueError;
    }

    if (!job) {
      const mongoJob = await ScrapeJob.findById(jobId).lean();
      if (
        mongoJob &&
        (getRequestContext(req).isAdmin ||
          String(mongoJob.user_id) === getRequestContext(req).userId)
      ) {
        job = mongoJob;
      }
    }

    if (!job) {
      return res.status(404).json({
        code: 404,
        success: false,
        message: "followers-scrape-job-not-found",
      });
    }

    return res.status(200).json({
      code: 200,
      success: true,
      message: "followers-scrape-job-status",
      data: {
        job,
      },
    });
  } catch (error) {
    return sendError(res, error);
  }
};

const pauseFollowersScrape = async (req, res) => {
  try {
    const { jobId } = req.params;

    if (!jobId) {
      return res.status(400).json({
        code: 400,
        success: false,
        message: t('jobId is required'),
      });
    }

    const result = await pauseFollowersScrapeJob(jobId, getRequestContext(req));

    return res.status(200).json({
      code: 200,
      success: true,
      message: result.reason,
      data: {
        changed: result.changed,
        job: result.job,
      },
    });
  } catch (error) {
    return sendError(res, error);
  }
};

const resumeFollowersScrape = async (req, res) => {
  try {
    const { jobId } = req.params;

    if (!jobId) {
      return res.status(400).json({
        code: 400,
        success: false,
        message: t('jobId is required'),
      });
    }

    const result = await resumeFollowersScrapeJob(jobId, getRequestContext(req));

    return res.status(200).json({
      code: 200,
      success: true,
      message: result.reason,
      data: {
        changed: result.changed,
        job: result.job,
      },
    });
  } catch (error) {
    return sendError(res, error);
  }
};

const deleteFollowersScrape = async (req, res) => {
  try {
    const { jobId } = req.params;

    if (!jobId) {
      return res.status(400).json({
        code: 400,
        success: false,
        message: t('jobId is required'),
      });
    }

    const result = await deleteFollowersScrapeJob(jobId, getRequestContext(req));

    return res.status(200).json({
      code: 200,
      success: true,
      message: result.reason,
      data: {
        changed: result.changed,
        job: null,
      },
    });
  } catch (error) {
    return sendError(res, error);
  }
};

const listFollowersScrapeJobs = async (req, res) => {
  try {
    const { userId } = getRequestContext(req);
    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "20", 10)));

    const result = await getFollowersScrapeJobsByUser(userId, { page, limit });

    return res.status(200).json({
      code: 200,
      success: true,
      message: "followers-scrape-jobs-list",
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

const getFollowersQueueStatus = async (req, res) => {
  try {
    const diagnostics = await getFollowersQueueDiagnostics();

    return res.status(200).json({
      code: 200,
      success: true,
      message: "followers-scrape-queue-status",
      data: diagnostics,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

const apifyInstagramWebhook = async (req, res) => {
  try {
    if (instagramConfig.apify.webhookSecret) {
      const providedSecret =
        req.get("x-apify-webhook-secret") ||
        req.get("x-webhook-secret") ||
        req.query.secret;

      if (providedSecret !== instagramConfig.apify.webhookSecret) {
        return res.status(401).json({
          code: 401,
          success: false,
          message: "invalid-apify-webhook-secret",
        });
      }
    }

    const result = await processApifyRelationshipWebhook({ payload: req.body });
    return res.status(200).json({
      code: 200,
      success: true,
      message: "apify-instagram-webhook-processed",
      data: {
        idempotent: Boolean(result.idempotent),
        terminal: Boolean(result.terminal),
        job_id: result.job?._id ? String(result.job._id) : null,
      },
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const BetaInstaController = {
  scrapeProfile,
  deepScan,
  scrapeFollowersOrFollowing,
  listFollowersScrapeJobs,
  getFollowersQueueStatus,
  getFollowersScrapeJob,
  pauseFollowersScrape,
  resumeFollowersScrape,
  deleteFollowersScrape,
  apifyInstagramWebhook,
};
