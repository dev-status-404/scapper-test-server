import dotenv from "dotenv";
import Joi from "joi";

dotenv.config();

const envVarsSchema = Joi.object()
  .keys({
    NODE_ENV: Joi.string()
      .valid("production", "development", "test")
      .required(),
    PORT: Joi.number().default(3000),

    // Database - either DB_URL or individual connection parameters are required
    MONGODB_URI: Joi.string().description(
      "Database connection URL (used for CockroachDB)",
    ),

    // JWT
    JWT_SECRET: Joi.string().required().description("JWT secret key"),
    JWT_ACCESS_EXPIRATION_MINUTES: Joi.number()
      .default(30)
      .description("minutes after which access tokens expire"),
    JWT_REFRESH_EXPIRATION_DAYS: Joi.number()
      .default(30)
      .description("days after which refresh tokens expire"),
    JWT_RESET_PASSWORD_EXPIRATION_MINUTES: Joi.number()
      .default(10)
      .description("minutes after which reset password token expires"),
    JWT_VERIFY_EMAIL_EXPIRATION_MINUTES: Joi.number()
      .default(10)
      .description("minutes after which verify email token expires"),
    JWT_RESET_LINK_EXPIRATION_MINUTES: Joi.number()
      .default(10)
      .description("minutes after which verify resetlink token expires"),

    // SMTP
    SMTP_HOST: Joi.string().description("server that will send the emails"),
    SMTP_PORT: Joi.number().description("port to connect to the email server"),
    SMTP_USERNAME: Joi.string().description("username for email server"),
    SMTP_PASSWORD: Joi.string().description("password for email server"),
    SMTP_PASSWORD: Joi.string().description(
      "the from field in the emails sent by the app",
    ),

    // Frontend
    FRONTEND_URL: Joi.string().description(
      "Frontend URL for CORS and email templates",
    ),

    // Cookie Encryption
    COOKIE_ENCRYPTION_KEY: Joi.string()
      .length(64)
      .description(
        "64-character hex key for encrypting Instagram account cookies",
      ),
    CRYPTO_SECRET_KEY: Joi.string()
      .length(64)
      .description(
        "64-character hex key for encrypting SMTP credentials and other secrets",
      ),

    // Stripe
    STRIPE_SECRET_KEY: Joi.string().description("Stripe secret API key"),
    STRIPE_WEBHOOK_SECRET: Joi.string().description(
      "Stripe webhook signing secret (whsec_...)",
    ),
    STRIPE_PUBLISHABLE_KEY: Joi.string().description("Stripe publishable key"),

    // Instagram provider/cost controls
    APIFY_API_KEY: Joi.string().allow("").description("Apify API token"),
    APIFY_INSTAGRAM_PROFILE_ACTOR_ID: Joi.string()
      .allow("")
      .description("Apify actor ID for Instagram profile enrichment"),
    APIFY_INSTAGRAM_FOLLOWERS_ACTOR_ID: Joi.string()
      .allow("")
      .description(
        "Optional verified Apify actor ID for Instagram followers collection",
      ),
    APIFY_INSTAGRAM_FOLLOWING_ACTOR_ID: Joi.string()
      .allow("")
      .description(
        "Optional verified Apify actor ID for Instagram following collection",
      ),
    APIFY_MAX_PROFILE_CHUNK_SIZE: Joi.number().integer().min(1).max(500),
    APIFY_MAX_PROFILE_CHUNK_SIZE_LARGE: Joi.number().integer().min(1).max(1000),
    APIFY_MAX_CONCURRENT_RUNS_PER_USER: Joi.number().integer().min(1),
    APIFY_MAX_CONCURRENT_RUNS_GLOBAL: Joi.number().integer().min(1),
    APIFY_MAX_CONCURRENT_RUNS_PER_TARGET: Joi.number().integer().min(1),
    APIFY_MAX_CONCURRENT_PROFILE_ENRICHMENT_RUNS: Joi.number().integer().min(1),
    APIFY_MAX_COST_USD_PER_JOB: Joi.number().min(0),
    APIFY_ESTIMATED_PROFILE_COST_USD: Joi.number().min(0),
    APIFY_WEBHOOK_URL: Joi.string().allow(""),
    APIFY_WEBHOOK_SECRET: Joi.string().allow(""),
    STEADY_API_KEY: Joi.string().allow(""),

    // Instagram proxy
    PROXY_HOST: Joi.string().allow(""),
    PROXY_USERNAME: Joi.string().allow(""),
    PROXY_PASSWORD: Joi.string().allow(""),
    PROXY_PORTS: Joi.string().allow(""),

    // Redis / BullMQ
    REDIS_HOST: Joi.string().default("127.0.0.1"),
    REDIS_PORT: Joi.number().default(6379),
    REDIS_USERNAME: Joi.string().allow("").default(""),
    REDIS_PASSWORD: Joi.string().allow("").default(""),
    REDIS_TLS: Joi.boolean().truthy("true").falsy("false").default(false),

    // Instagram stage limits
    INSTAGRAM_DEEP_SCAN_ENABLED: Joi.boolean().truthy("true").falsy("false"),
    INSTAGRAM_DEEP_SCAN_MAX_URLS_PER_JOB: Joi.number().integer().min(0),
    DEEP_SCAN_ENABLED: Joi.boolean().truthy("true").falsy("false"),
    DEEP_SCAN_RELATIONSHIP_ENABLED: Joi.boolean().truthy("true").falsy("false"),
    DEEP_SCAN_INLINE_SINGLE_PROFILE: Joi.boolean()
      .truthy("true")
      .falsy("false"),
    DEEP_SCAN_TIMEOUT_MS: Joi.number().integer().min(3000).max(60000),
    DEEP_SCAN_RETRY_DELAY_MS: Joi.number().integer().min(1000).max(60000),
    DEEP_SCAN_MAX_ATTEMPTS: Joi.number().integer().min(1).max(5),
    DEEP_SCAN_MAX_REDIRECTS: Joi.number().integer().min(0).max(5),
    DEEP_SCAN_MAX_CONTENT_BYTES: Joi.number()
      .integer()
      .min(128 * 1024)
      .max(2 * 1024 * 1024),
    DEEP_SCAN_MAX_PAGES_PER_DOMAIN: Joi.number().integer().min(1).max(10),
    DEEP_SCAN_CACHE_TTL_DAYS: Joi.number().integer().min(1).max(365),
    DEEP_SCAN_CONCURRENCY_GLOBAL: Joi.number().integer().min(1).max(100),
    DEEP_SCAN_CONCURRENCY_PER_USER: Joi.number().integer().min(1).max(20),
    DEEP_SCAN_CONCURRENCY_PER_DOMAIN: Joi.number().integer().min(1).max(5),
    DEEP_SCAN_USER_AGENT: Joi.string().allow(""),
    INSTAGRAM_ENRICHMENT_DEFAULT_LIMIT: Joi.number().integer().min(0),
    INSTAGRAM_ENRICHMENT_MAX_LIMIT: Joi.number().integer().min(1),
    INSTAGRAM_RELATIONSHIP_MAX_LIMIT_FREE_PLAN: Joi.number().integer().min(1),
    INSTAGRAM_RELATIONSHIP_MAX_LIMIT_PAID_PLAN: Joi.number().integer().min(1),
    INSTAGRAM_RELATIONSHIP_MAX_LIMIT_ENTERPRISE: Joi.number().integer().min(1),
  })
  .unknown();

const { value: envVars, error } = envVarsSchema
  .prefs({ errors: { label: "key" } })
  .validate(process.env);

if (error) {
  throw new Error(`Config validation error: ${error.message}`);
}

// Custom validation for database connection
if (
  !envVars.MONGODB_URI &&
  !(envVars.DB_HOST && envVars.DB_NAME && envVars.DB_USER)
) {
  throw new Error(
    "Either DB_URL or all of DB_HOST, DB_NAME, and DB_USER must be provided",
  );
}

const config = {
  env: envVars.NODE_ENV,
  port: envVars.PORT,
  frontendUrl: envVars.FRONTEND_URL,

  db: {
    url: envVars.DB_URL,
  },

  crypto: {
    secretKey: envVars.CRYPTO_SECRET_KEY,
  },

  jwt: {
    secret: envVars.JWT_SECRET,
    accessExpirationMinutes: envVars.JWT_ACCESS_EXPIRATION_MINUTES,
    refreshExpirationDays: envVars.JWT_REFRESH_EXPIRATION_DAYS,
    resetPasswordExpirationMinutes:
      envVars.JWT_RESET_PASSWORD_EXPIRATION_MINUTES,
    verifyEmailExpirationMinutes: envVars.JWT_VERIFY_EMAIL_EXPIRATION_MINUTES,
    verifyResetLinkExpirationMinutes:
      envVars.VERIFY_RESET_LINK_EXPIRATION_MINUTES,
    resetLinkExpirationMinutes: envVars.JWT_RESET_LINK_EXPIRATION_MINUTES,
  },

  email: {
    smtp: {
      host: envVars.SMTP_HOST,
      port: envVars.SMTP_PORT,
      auth: {
        user: envVars.SMTP_USERNAME,
        pass: envVars.SMTP_PASSWORD,
      },
    },
    from: envVars.EMAIL_FROM,
  },

  recaptcha: {
    siteKey: envVars.RECAPTCHA_SITE_KEY,
    secretKey: envVars.RECAPTCHA_SECRET_KEY,
  },

  google: {
    clientId: envVars.GOOGLE_CLIENT_ID,
    clientSecret: envVars.GOOGLE_CLIENT_SECRET,
  },
  websocket: {
    ws_cors_origin: envVars.WS_CORS_ORIGIN,
    ws_path: envVars.WS_PATH,
  },
  stripe: {
    secretKey: envVars.STRIPE_SECRET_KEY,
    webhookSecret: envVars.STRIPE_WEBHOOK_SECRET,
    publishableKey: envVars.STRIPE_PUBLISHABLE_KEY,
  },
};

export default config;

export const {
  env,
  port,
  frontendUrl,
  jwt: {
    secret,
    accessExpirationMinutes,
    refreshExpirationDays,
    resetPasswordExpirationMinutes,
    verifyEmailExpirationMinutes,
  },
} = config;

export const NODE_ENV = env;
export const PORT = port;
export const FRONTEND_URL = frontendUrl;
export const JWT_SECRET = secret;
export const JWT_ACCESS_EXPIRATION_MINUTES = accessExpirationMinutes;
export const JWT_REFRESH_EXPIRATION_DAYS = refreshExpirationDays;
export const JWT_RESET_PASSWORD_EXPIRATION_MINUTES =
  resetPasswordExpirationMinutes;
export const JWT_VERIFY_EMAIL_EXPIRATION_MINUTES = verifyEmailExpirationMinutes;
