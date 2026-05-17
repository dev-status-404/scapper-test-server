export class ProviderError extends Error {
  constructor(message, { provider = null, retryable = false, cause = null, metadata = {} } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.provider = provider;
    this.retryable = retryable;
    this.cause = cause;
    this.metadata = metadata;
  }
}

export class ProviderRateLimitError extends ProviderError {
  constructor(message = "provider-rate-limited", options = {}) {
    super(message, { ...options, retryable: options.retryable ?? true });
  }
}

export class ProviderAuthError extends ProviderError {
  constructor(message = "provider-auth-failed", options = {}) {
    super(message, { ...options, retryable: false });
  }
}

export class ProviderTimeoutError extends ProviderError {
  constructor(message = "provider-timeout", options = {}) {
    super(message, { ...options, retryable: options.retryable ?? true });
  }
}

export class ProviderCostLimitError extends ProviderError {
  constructor(message = "provider-cost-limit-exceeded", options = {}) {
    super(message, { ...options, retryable: false });
  }
}

export class ProviderInvalidInputError extends ProviderError {
  constructor(message = "provider-invalid-input", options = {}) {
    super(message, { ...options, retryable: false });
  }
}

export class ProviderEmptyResultError extends ProviderError {
  constructor(message = "provider-empty-result", options = {}) {
    super(message, { ...options, retryable: false });
  }
}

export class ProviderPartialResultError extends ProviderError {
  constructor(message = "provider-partial-result", options = {}) {
    super(message, { ...options, retryable: options.retryable ?? true });
  }
}

export class ProviderUnsupportedOperationError extends ProviderError {
  constructor(message = "provider-unsupported-operation", options = {}) {
    super(message, { ...options, retryable: false });
  }
}

export class JobCancelledError extends Error {
  constructor(message = "job-cancelled", metadata = {}) {
    super(message);
    this.name = "JobCancelledError";
    this.metadata = metadata;
  }
}

export class JobPausedError extends Error {
  constructor(message = "job-paused", metadata = {}) {
    super(message);
    this.name = "JobPausedError";
    this.metadata = metadata;
  }
}

export const classifyProviderError = (error, provider = null) => {
  if (error instanceof ProviderError) return error;

  const status =
    error?.response?.status ??
    error?.statusCode ??
    error?.status ??
    error?.response?.statusCode ??
    null;
  const message = String(error?.message || "provider-error");
  const lower = message.toLowerCase();

  if (status === 401 || status === 403 || lower.includes("token")) {
    return new ProviderAuthError(message, { provider, cause: error });
  }
  if (status === 429 || lower.includes("rate limit") || lower.includes("too many requests")) {
    return new ProviderRateLimitError(message, { provider, cause: error });
  }
  if (
    error?.code === "ETIMEDOUT" ||
    error?.code === "ECONNABORTED" ||
    lower.includes("timeout")
  ) {
    return new ProviderTimeoutError(message, { provider, cause: error });
  }

  return new ProviderError(message, {
    provider,
    retryable: status === 500 || status === 502 || status === 503 || status === 504,
    cause: error,
  });
};
