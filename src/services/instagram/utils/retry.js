import {
  ProviderError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  classifyProviderError,
} from "../errors.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const withTimeout = async (promise, timeoutMs, message = "operation timed out") => {
  if (!timeoutMs || timeoutMs <= 0) return promise;

  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new ProviderTimeoutError(message));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
};

export const getRetryDelayMs = ({
  attempt,
  baseDelayMs = 1000,
  maxDelayMs = 30000,
  jitter = 0.35,
}) => {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const jitterRange = exponential * jitter;
  return Math.round(exponential - jitterRange + Math.random() * jitterRange * 2);
};

export const withRetry = async (
  fn,
  {
    attempts = 3,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    provider = null,
    retryable = null,
    onRetry = null,
  } = {},
) => {
  let lastError;

  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      const classified = classifyProviderError(error, provider);
      lastError = classified;
      const isRetryable =
        typeof retryable === "function"
          ? retryable(classified)
          : classified.retryable ||
            classified instanceof ProviderRateLimitError ||
            classified instanceof ProviderTimeoutError;

      if (!isRetryable || attempt >= attempts) {
        throw classified;
      }

      const delayMs = getRetryDelayMs({ attempt, baseDelayMs, maxDelayMs });
      await onRetry?.({ error: classified, attempt, delayMs });
      await sleep(delayMs);
    }
  }

  throw lastError || new ProviderError("retry-failed", { provider });
};

