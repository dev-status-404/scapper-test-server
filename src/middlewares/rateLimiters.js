import { rateLimit } from "express-rate-limit";

// Rate limiter for Instagram scraping endpoints
// More restrictive to prevent abuse and Instagram rate limits
export const scrapeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 scraping requests per 15 minutes
  message: {
    code: 429,
    success: false,
    message: "Too many scraping requests, please try again later",
    retry_after: "15 minutes",
  },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  handler: (req, res) => {
    res.status(429).json({
      code: 429,
      success: false,
      message:
        "Too many scraping requests. Instagram has rate limits to prevent abuse.",
      retry_after: "15 minutes",
      current_limit: "10 requests per 15 minutes",
    });
  },
});

// Rate limiter for follower/following scraping (more restrictive)
export const followerScrapeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // Limit to 5 follower scrapes per hour (these are intensive)
  message: {
    code: 429,
    success: false,
    message:
      "Follower scraping limit reached. These operations are resource-intensive.",
    retry_after: "1 hour",
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      code: 429,
      success: false,
      message:
        "Follower scraping limit reached. This operation takes significant time and resources.",
      retry_after: "1 hour",
      current_limit: "5 follower scrapes per hour",
      tip: "Consider using smaller maxLimit values to stay within limits",
    });
  },
});

// General API rate limiter
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per 15 minutes
  message: {
    code: 429,
    success: false,
    message:
      "Too many requests from this IP, please try again after 15 minutes",
  },
  standardHeaders: true,
  legacyHeaders: false,
});
