import IORedis from "ioredis";

const parseInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const isTlsEnabled = () => process.env.REDIS_TLS === "true";

export const getRedisConnectionOptions = ({ connectionName } = {}) => {
  const host = process.env.REDIS_HOST || "127.0.0.1";

  return {
    host,
    port: parseInteger(process.env.REDIS_PORT, 6379),
    username: process.env.REDIS_USERNAME || undefined,
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
    ...(connectionName ? { connectionName } : {}),
    ...(isTlsEnabled()
      ? {
          tls: {
            servername: host,
          },
        }
      : {}),
  };
};

let sharedRedisClient = null;

export const getSharedRedisClient = () => {
  if (!sharedRedisClient) {
    sharedRedisClient = new IORedis(
      getRedisConnectionOptions({ connectionName: "shared-app-redis" }),
    );
    sharedRedisClient.on("error", (error) => {
      console.error(
        `[Redis] Shared client error: ${error?.message || "unknown-error"}`,
      );
    });
  }

  return sharedRedisClient;
};

export const createRedisClient = (connectionName) =>
  new IORedis(getRedisConnectionOptions({ connectionName }));

export default {
  createRedisClient,
  getRedisConnectionOptions,
  getSharedRedisClient,
};
