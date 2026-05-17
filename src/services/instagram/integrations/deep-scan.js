export {
  deepScanExternalUrl,
  deepScanUrl,
  shouldSkipDeepScanDomain,
  normalizeDeepScanUrl,
  validateUrlSafeToFetch,
  isPrivateOrInternalIp,
  enqueueDeepScanForLead,
  enqueueDeepScanBatch,
  processDeepScanJob,
  attachDeepScanResultToLeads,
  isDeepScanRetryableError,
  discoverContactPageUrls,
  extractDeepScanContactsFromHtml,
  buildDeepScanQueueJobId,
} from "../deepScanService.js";

export { default } from "../deepScanService.js";

