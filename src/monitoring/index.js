import crypto from "crypto";
import { Sentry, isSentryEnabled } from "./sentry.js";
import {
  annotateActiveDatadogSpan,
  flushDatadog,
  isDatadogEnabled,
  withDatadogSpan,
} from "./datadog.js";

const normalizeUser = (user) => {
  if (!user) {
    return null;
  }

  return {
    id: user._id?.toString?.() || user.id?.toString?.() || undefined,
    email: user.email || undefined,
    username: user.username || undefined,
    role: user.role || undefined,
  };
};

const setScopeContext = (scope, context = {}) => {
  if (context.level && typeof scope.setLevel === "function") {
    scope.setLevel(context.level);
  }

  if (context.tags && typeof scope.setTags === "function") {
    scope.setTags(
      Object.fromEntries(
        Object.entries(context.tags).map(([key, value]) => [key, String(value)]),
      ),
    );
  }

  if (context.user && typeof scope.setUser === "function") {
    scope.setUser(normalizeUser(context.user));
  }

  if (context.extra && typeof scope.setExtra === "function") {
    Object.entries(context.extra).forEach(([key, value]) => {
      scope.setExtra(key, value);
    });
  }

  if (context.contexts && typeof scope.setContext === "function") {
    Object.entries(context.contexts).forEach(([key, value]) => {
      if (value && typeof value === "object") {
        scope.setContext(key, value);
      }
    });
  }
};

export const toError = (errorLike, fallbackMessage = "unknown-error") => {
  if (errorLike instanceof Error) {
    return errorLike;
  }

  return new Error(
    typeof errorLike === "string"
      ? errorLike
      : errorLike?.message || fallbackMessage,
  );
};

export const captureException = (error, context = {}) => {
  if (!isSentryEnabled()) {
    return null;
  }

  return Sentry.withScope((scope) => {
    setScopeContext(scope, context);
    return Sentry.captureException(toError(error));
  });
};

export const captureMessage = (
  message,
  { level = "error", ...context } = {},
) => {
  if (!isSentryEnabled()) {
    return null;
  }

  return Sentry.withScope((scope) => {
    setScopeContext(scope, { ...context, level });
    return Sentry.captureMessage(message, level);
  });
};

export const setMonitoringUser = (user, req = null) => {
  const normalizedUser = normalizeUser(user);

  if (!normalizedUser) {
    return;
  }

  if (isSentryEnabled()) {
    Sentry.setUser(normalizedUser);
    if (normalizedUser.role) {
      Sentry.setTag("user_role", normalizedUser.role);
    }
  }

  annotateActiveDatadogSpan({
    "user.id": normalizedUser.id,
    "user.email": normalizedUser.email,
    "user.role": normalizedUser.role,
    "request.id": req?.requestId,
  });
};

export const monitoringRequestMiddleware = (logger) => (req, res, next) => {
  const requestId =
    String(req.headers["x-request-id"] || "").trim() || crypto.randomUUID();
  const startedAt = process.hrtime.bigint();
  const requestPath = req.path || req.originalUrl || "/";

  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);

  if (isSentryEnabled()) {
    Sentry.setTag("request_id", requestId);
    Sentry.setContext("request_meta", {
      request_id: requestId,
      method: req.method,
      path: requestPath,
    });
  }

  annotateActiveDatadogSpan({
    "request.id": requestId,
    "http.method": req.method,
    "http.route": requestPath,
  });

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const userId = req.user?._id?.toString?.() || null;
    const logPayload = {
      request_id: requestId,
      method: req.method,
      path: requestPath,
      status_code: res.statusCode,
      duration_ms: Number(durationMs.toFixed(2)),
      user_id: userId,
    };

    annotateActiveDatadogSpan({
      "request.id": requestId,
      "user.id": userId,
      "http.status_code": res.statusCode,
      "http.response_time_ms": Number(durationMs.toFixed(2)),
    });

    if (res.statusCode >= 500) {
      logger.error(logPayload, "request completed with server error");
      return;
    }

    if (res.statusCode >= 400) {
      logger.warn(logPayload, "request completed with client error");
      return;
    }

    logger.info(logPayload, "request completed");
  });

  next();
};

export const withMonitoringSpan = async (
  name,
  { op = "task", attributes = {} } = {},
  callback,
) => {
  const runDatadogSpan = async () => withDatadogSpan(name, attributes, callback);

  if (!isSentryEnabled()) {
    return runDatadogSpan();
  }

  return Sentry.startSpan({ name, op, attributes }, async () => runDatadogSpan());
};

export const bindErrorContext = ({
  req = null,
  tags = {},
  extra = {},
  user = null,
  level = "error",
} = {}) => {
  const requestPath = req?.path || req?.originalUrl || null;

  return {
  level,
  tags: {
    request_id: req?.requestId,
    method: req?.method,
    path: requestPath,
    ...tags,
  },
  user: user || req?.user || null,
  extra: {
    request_id: req?.requestId,
    method: req?.method,
    path: requestPath,
    ...extra,
  },
  };
};

export const flushMonitoring = async (timeout = 2000) => {
  const pending = [Promise.resolve(flushDatadog())];

  if (isSentryEnabled()) {
    pending.push(Sentry.close(timeout));
  }

  await Promise.allSettled(pending);
};

export { Sentry, isDatadogEnabled, isSentryEnabled };
