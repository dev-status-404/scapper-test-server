import fs from "fs";
import os from "os";
import path from "path";
import axios from "axios";
import * as cheerio from "cheerio";
import { PlaywrightCrawler } from "crawlee";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { extractEmails, extractPhones } from "../utils/extractor.js";
import { HttpsProxyAgent } from "https-proxy-agent";
import { requireProxyConfig } from "../config/instagram.js";
import {
  DEEP_SCAN_INLINE_SINGLE_PROFILE,
  deepScanExternalUrl as queuedDeepScanExternalUrl,
} from "./deepScanService.js";

chromium.use(StealthPlugin());

const STORAGE_DIR = path.resolve(process.cwd(), "storage");
const COOKIES_FILE_PATH = path.join(STORAGE_DIR, "cookies.json");
const CRAWLEE_RUNTIME_DIR = process.env.CRAWLEE_STORAGE_DIR
  ? path.resolve(process.env.CRAWLEE_STORAGE_DIR)
  : path.join(os.tmpdir(), "scapper-backend-crawlee");

class ProxyManager {
  constructor() {
    this.index = 0;
    this.agent = null;
  }

  getPort() {
    const proxyConfig = requireProxyConfig();
    return proxyConfig.ports[this.index];
  }

  rotate() {
    const proxyConfig = requireProxyConfig();
    this.index = (this.index + 1) % proxyConfig.ports.length;
    this.agent = null;

    console.log(`[ProxyManager] Rotated to port ${this.getPort()}`);
  }

  getProxyUrl() {
    const proxyConfig = requireProxyConfig();
    const username = encodeURIComponent(proxyConfig.username);
    const password = encodeURIComponent(proxyConfig.password);

    return `http://${username}:${password}@${proxyConfig.host}:${this.getPort()}`;
  }

  getProxyAgent() {
    if (!this.agent) {
      this.agent = new HttpsProxyAgent(this.getProxyUrl());
    }

    return this.agent;
  }
}

const proxyManager = new ProxyManager();

class ThrottleManager {
  constructor() {
    this.requestCount = 0;
    this.lastPauseAt = 0;
  }
  async randomDelay() {
    const delayMs = Math.floor(Math.random() * (6000 - 3000 + 1)) + 3000;
    console.log(`[ThrottleManager] Waiting ${delayMs}ms`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  async checkBatchPause() {
    this.requestCount++;
    if (
      this.requestCount % 50 === 0 &&
      this.requestCount !== this.lastPauseAt
    ) {
      console.log(
        `[ThrottleManager] Reached ${this.requestCount} requests, pausing for 60 seconds`,
      );
      this.lastPauseAt = this.requestCount;
      await new Promise((resolve) => setTimeout(resolve, 60000));
    }
  }
  async handleRateLimit() {
    console.log(
      "[ThrottleManager] Rate limit detected (429), pausing for 2 minutes",
    );
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  async throttle() {
    await this.randomDelay();
    await this.checkBatchPause();
  }
  reset() {
    this.requestCount = 0;
    this.lastPauseAt = 0;
  }
}

const throttleManager = new ThrottleManager();

class AntiBotDetector {
  isBlocked(statusCode, url = "") {
    const triggers = [
      statusCode === 429,
      statusCode === 403,
      /\/accounts\/login/i.test(url),
      /\/challenge\//i.test(url),
    ];
    return triggers.some((trigger) => trigger === true);
  }
  async handleBlockedRequest(error, retryFn, maxRetries = 6) {
    const statusCode = error?.response?.status;
    const url = error?.response?.config?.url || error?.config?.url || "";
    if (this.isBlocked(statusCode, url)) {
      console.log(
        `[AntiBotDetector] Blocked detected: status=${statusCode}, url=${url}`,
      );
      if (statusCode === 429) {
        await throttleManager.handleRateLimit();
      }
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        console.log(`[AntiBotDetector] Retry attempt ${attempt}/${maxRetries}`);
        proxyManager.rotate();
        refreshAxiosInstance();
        try {
          return await retryFn();
        } catch (retryError) {
          if (attempt === maxRetries) throw retryError;
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }
    }
    throw error;
  }
}

const antiBotDetector = new AntiBotDetector();

const createAxiosInstance = () =>
  axios.create({
    timeout: 30000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    },
    httpsAgent: proxyManager.getProxyAgent(),
    proxy: false,
  });

let axiosInstance = createAxiosInstance();

const refreshAxiosInstance = () => {
  axiosInstance = createAxiosInstance();
};

const randomDelayMs = () =>
  Math.floor(Math.random() * (5000 - 2000 + 1)) + 2000;

const IG_APP_ID = "936619743392459";

const readCookies = async () => {
  try {
    if (!fs.existsSync(COOKIES_FILE_PATH)) return [];

    const payload = await fs.promises.readFile(COOKIES_FILE_PATH, "utf-8");
    const parsed = JSON.parse(payload);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const isValidExternalUrl = (value) => {
  if (!value || typeof value !== "string") return false;

  try {
    const parsed = new URL(value);
    return (
      /^https?:$/.test(parsed.protocol) &&
      !parsed.hostname.includes("instagram.com")
    );
  } catch {
    return false;
  }
};

const ensureStorageArtifacts = async () => {
  await fs.promises.mkdir(STORAGE_DIR, { recursive: true });

  if (!fs.existsSync(COOKIES_FILE_PATH)) {
    await fs.promises.writeFile(COOKIES_FILE_PATH, "[]\n", "utf-8");
  }
};

const normalizeInstagramUrl = (url) => {
  if (!url || typeof url !== "string") return null;

  const trimmed = url.trim();
  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    const parsed = new URL(withProtocol);

    const isInstagramHost =
      parsed.hostname === "instagram.com" ||
      parsed.hostname === "www.instagram.com";

    if (!isInstagramHost) return null;

    const firstPathSegment =
      parsed.pathname.split("/").filter(Boolean)[0] || "";
    const disallowed = new Set(["p", "reel", "stories", "explore"]);

    if (!firstPathSegment || disallowed.has(firstPathSegment.toLowerCase())) {
      return null;
    }

    return parsed.toString();
  } catch {
    return null;
  }
};

const normalizeExternalUrl = (externalUrl) => {
  if (!externalUrl || typeof externalUrl !== "string") return null;

  try {
    const parsed = new URL(externalUrl);

    if (parsed.hostname === "l.instagram.com") {
      const redirected = parsed.searchParams.get("u");
      if (redirected) return decodeURIComponent(redirected);
    }

    return parsed.toString();
  } catch {
    return null;
  }
};

const deepScanExternalUrl = async (externalUrl) => {
  const safeExternalUrl = normalizeExternalUrl(externalUrl);

  if (!safeExternalUrl) {
    return {
      source_url: null,
      emails: [],
      phone_numbers: [],
      html_title: null,
    };
  }

  if (!DEEP_SCAN_INLINE_SINGLE_PROFILE) {
    return {
      source_url: safeExternalUrl,
      emails: [],
      phone_numbers: [],
      html_title: null,
      queued: false,
    };
  }

  return queuedDeepScanExternalUrl(safeExternalUrl);

  try {
    const response = await axiosInstance.get(safeExternalUrl, {
      timeout: 30000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      },
      maxRedirects: 5,
    });

    const html = typeof response.data === "string" ? response.data : "";
    const $ = cheerio.load(html);
    const visibleText = $("body").text();

    return {
      source_url: safeExternalUrl,
      emails: extractEmails(`${html}\n${visibleText}`),
      phone_numbers: extractPhones(`${html}\n${visibleText}`),
      html_title: $("title").first().text().trim() || null,
    };
  } catch {
    return {
      source_url: safeExternalUrl,
      emails: [],
      phone_numbers: [],
      html_title: null,
    };
  }
};

const USER_AGENTS = [
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; Samsung Galaxy S22) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36",
];

const IG_HEADERS = async (username) => {
  const cookies = await readCookies();

  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

  const csrfToken = cookies.find((c) => c.name === "csrftoken")?.value || "";

  return {
    "x-ig-app-id": IG_APP_ID,
    "x-ig-www-claim": "0",
    "x-instagram-ajax": "1017950098",
    "x-asbd-id": "129477",
    "User-Agent": USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
    Accept: "*/*",
    "x-requested-with": "XMLHttpRequest",
    "x-csrftoken": csrfToken,
    Referer: `https://www.instagram.com/${username}/`,
    Cookie: cookieHeader,
  };
};

const scrapeViaApi = async (username) => {
  await throttleManager.throttle();

  const headers = await IG_HEADERS(username); // ← await now

  const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;

  // Try direct first
  try {
    console.log("[Stage1] Trying direct...");
    const response = await axiosInstance.get(url, { timeout: 15000, headers });
    console.log("[Stage1] Direct succeeded");
    return parseUserData(response.data?.data?.user);
  } catch (directError) {
    console.log(
      `[Stage1] Direct failed: ${directError.response?.status}, trying proxy...`,
    );
  }

  // Proxy fallback
  const makeRequest = async () => {
    return await axiosInstance.get(url, { timeout: 15000, headers });
  };

  let response;
  try {
    response = await makeRequest();
  } catch (error) {
    response = await antiBotDetector.handleBlockedRequest(error, makeRequest);
  }

  const userData = response.data?.data?.user;
  if (!userData) throw new Error("instagram-api-empty-response");

  const links = Array.isArray(userData.bio_links)
    ? userData.bio_links
        .filter((l) => l.url)
        .map((l) => ({
          title: l.title || null,
          url: l.url || null,
          lynx_url: l.lynx_url || null,
          link_type: l.link_type || null,
        }))
    : [];

  return {
    id: userData.id || null,
    username: userData.username || null,
    full_name: userData.full_name || null,
    bio:
      userData.biography_with_entities?.raw_text || userData.biography || null,
    avatar_url: userData.profile_pic_url_hd || userData.profile_pic_url || null,
    followers:
      userData.edge_followed_by?.count != null
        ? userData.edge_followed_by.count
        : null,
    following:
      userData.edge_follow?.count != null ? userData.edge_follow.count : null,
    category: userData.category_name || null,
    external_url: userData.external_url || null,
    external_url_linkshimmed: userData.external_url_linkshimmed || null,
    is_private: userData.is_private ?? null,
    is_verified: userData.is_verified ?? null,
    fb_profile_biolink: userData.fb_profile_biolink
      ? {
          url: userData.fb_profile_biolink.url || null,
          name: userData.fb_profile_biolink.name || null,
        }
      : null,
    highlight_reel_count: userData.highlight_reel_count ?? null,
    links,
  };
};

const scrapeInstagramProfile = async ({ profileUrl }) => {
  const normalizedUrl = normalizeInstagramUrl(profileUrl);

  if (!normalizedUrl) {
    return {
      code: 400,
      success: false,
      message: "valid-instagram-profile-url-is-required",
    };
  }

  await ensureStorageArtifacts();

  const requestedUsername =
    new URL(normalizedUrl).pathname.split("/").filter(Boolean)[0] || null;

  // ── Stage 1: fast API path ──────────────────────────────────────────────────
  try {
    const apiProfile = await scrapeViaApi(requestedUsername);
    const deepScan = await deepScanExternalUrl(apiProfile.external_url);

    const successResponse = {
      code: 200,
      success: true,
      message: "instagram-profile-scraped-successfully",
      data: {
        profile: { source_url: normalizedUrl, ...apiProfile },
        deep_scan: deepScan,
      },
    };

    console.log(
      "instagram-scrape-response",
      JSON.stringify(successResponse, null, 2),
    );
    return successResponse;
  } catch (apiError) {
    console.log(
      "instagram-api-fallback",
      apiError.response?.status ?? apiError.message,
    );
    // Fall through to Playwright crawler below.
  }

  // ── Stage 2: Playwright fallback ────────────────────────────────────────────
  process.env.CRAWLEE_STORAGE_DIR = CRAWLEE_RUNTIME_DIR;

  let profile = null;
  let authRequired = false;

  const crawler = new PlaywrightCrawler({
    maxRequestRetries: 3,
    requestHandlerTimeoutSecs: 60,
    launchContext: {
      launcher: chromium,
      launchOptions: {
        headless: false, // Show browser window
      },
    },
    preNavigationHooks: [
      async ({ page }) => {
        const cookies = await readCookies();
        if (cookies.length > 0) {
          await page.context().addCookies(cookies);
        }
      },
    ],
    requestHandler: async ({ page, request }) => {
      await page.waitForTimeout(randomDelayMs());

      await page.waitForLoadState("domcontentloaded", { timeout: 30000 });

      const loadedUrl = request.loadedUrl || request.url;
      if (/\/accounts\/(login|emailsignup)/i.test(loadedUrl)) {
        authRequired = true;
        throw new Error("instagram-auth-required");
      }

      // Expand collapsed bio content when Instagram shows a trailing "... more" token.
      try {
        await page.evaluate(() => {
          const nodes = Array.from(
            document.querySelectorAll(
              "header section div[role='button'], header section span, header section a",
            ),
          );

          const isBioMoreTrigger = (text) => {
            const value = (text || "").trim().toLowerCase();
            if (!value) return false;
            if (/and\s+\d+\s+more/.test(value)) return false;
            return (
              value === "more" || value === "... more" || value === "… more"
            );
          };

          const trigger = nodes.find((node) =>
            isBioMoreTrigger(node.textContent),
          );
          if (trigger) trigger.click();
        });

        await page.waitForTimeout(700);
      } catch {
        // Ignore if bio is already expanded or no trigger exists.
      }

      // Try opening the links modal to capture all bio links ("and X more").
      try {
        const moreLinksTextLocator = page
          .locator("div[dir='auto']")
          .filter({ hasText: /and\s+\d+\s+more/i })
          .first();

        const triggerCandidates = [
          moreLinksTextLocator.locator("xpath=ancestor::button[1]"),
          page
            .locator("a")
            .filter({ hasText: /and\s+\d+\s+more/i })
            .first(),
          page
            .locator('[role="button"]')
            .filter({ hasText: /and\s+\d+\s+more/i })
            .first(),
          page
            .locator("span")
            .filter({ hasText: /and\s+\d+\s+more/i })
            .first(),
        ];

        for (const candidate of triggerCandidates) {
          if (await candidate.count()) {
            await candidate.scrollIntoViewIfNeeded().catch(() => {});
            await candidate.click({ timeout: 3000, force: true });
            await page.waitForTimeout(900);
            break;
          }
        }
      } catch {
        // Ignore modal-open failures and continue with default extraction.
      }

      const extracted = await page.evaluate(() => {
        const textOf = (selector) => {
          const element = document.querySelector(selector);
          return element?.textContent?.trim() || null;
        };

        const attrOf = (selector, attr) => {
          const element = document.querySelector(selector);
          return element?.getAttribute(attr)?.trim() || null;
        };

        const isBlockedInstagramUrl = (rawUrl) => {
          try {
            const parsed = new URL(rawUrl, window.location.origin);
            const host = parsed.hostname.toLowerCase();
            const path = parsed.pathname.toLowerCase();

            if (rawUrl.includes("l.instagram.com/?u=")) return false;
            if (!host.includes("instagram.com")) return false;

            return (
              host === "help.instagram.com" ||
              host === "privacycenter.instagram.com" ||
              path.includes("/accounts/login") ||
              path.includes("/accounts/emailsignup") ||
              path.includes("/accounts/password") ||
              path.includes("/accounts/reset") ||
              path.includes("/challenge/") ||
              path.includes("/accounts/") ||
              path.includes("/legal/") ||
              path.includes("/terms/")
            );
          } catch {
            return true;
          }
        };

        const toCandidateUrl = (rawValue) => {
          if (!rawValue || typeof rawValue !== "string") return null;
          const value = rawValue.trim();
          if (!value || value === "#") return null;

          const withProtocol = /^https?:\/\//i.test(value)
            ? value
            : `https://${value}`;

          try {
            const parsed = new URL(withProtocol, window.location.origin);
            const normalized = parsed.toString();
            if (isBlockedInstagramUrl(normalized)) return null;
            return normalized;
          } catch {
            return null;
          }
        };

        const pickExternalUrl = () => {
          const anchors = Array.from(
            document.querySelectorAll("header section a[href]"),
          );
          const hrefs = anchors
            .map((anchor) => anchor.getAttribute("href")?.trim() || "")
            .filter(Boolean)
            .filter((href) => !isBlockedInstagramUrl(href));

          const preferred = hrefs.find((href) =>
            href.includes("l.instagram.com/?u="),
          );
          if (preferred) return preferred;

          const direct = hrefs.find((href) => {
            if (!/^https?:\/\//i.test(href)) return false;

            try {
              const parsed = new URL(href);
              if (parsed.hostname.includes("instagram.com")) return false;
              return true;
            } catch {
              return false;
            }
          });

          return direct || null;
        };

        const toAbsoluteHref = (href) => {
          if (!href) return null;

          try {
            return new URL(href, window.location.origin).toString();
          } catch {
            return null;
          }
        };

        const extractLinksFromModal = () => {
          const dialogs = Array.from(
            document.querySelectorAll('div[role="dialog"]'),
          );
          const linksDialog = dialogs.find((dialog) =>
            /links/i.test(dialog.textContent || ""),
          );

          if (!linksDialog) return [];

          const allAnchors = Array.from(
            linksDialog.querySelectorAll("a[href]"),
          );
          const allButtons = Array.from(linksDialog.querySelectorAll("button"));
          const seen = new Set();

          const fromAnchors = allAnchors
            .map((anchor) => {
              const absoluteUrl = toCandidateUrl(
                toAbsoluteHref(anchor.getAttribute("href")?.trim() || ""),
              );
              if (!absoluteUrl || seen.has(absoluteUrl)) return null;

              seen.add(absoluteUrl);

              const chunks = (anchor.textContent || "")
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean);

              return {
                url: absoluteUrl,
                title: chunks[0] || null,
                subtitle: chunks.slice(1).join(" ") || null,
              };
            })
            .filter(Boolean);

          const fromButtons = allButtons
            .map((button) => {
              const chunks = (button.textContent || "")
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean);

              const rawUrlLine = chunks.find(
                (line) =>
                  /(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+\.[a-z]{2,}/i.test(
                    line,
                  ) && !/and\s+\d+\s+more/i.test(line),
              );

              const absoluteUrl = toCandidateUrl(rawUrlLine || "");
              if (!absoluteUrl || seen.has(absoluteUrl)) return null;

              seen.add(absoluteUrl);

              return {
                url: absoluteUrl,
                title: chunks[0] || null,
                subtitle: rawUrlLine || chunks.slice(1).join(" ") || null,
              };
            })
            .filter(Boolean);

          return [...fromAnchors, ...fromButtons];
        };

        const extractCollapsedLinksText = () => {
          const lines = Array.from(
            document.querySelectorAll(
              "header section div[dir='auto'], header div[dir='auto']",
            ),
          )
            .map((element) => (element.textContent || "").trim())
            .filter(Boolean);

          return lines
            .filter(
              (line) =>
                /and\s+\d+\s+more/i.test(line) ||
                /(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+\.[a-z]{2,}/i.test(line),
            )
            .map((line) => {
              const matched = line.match(
                /((?:https?:\/\/)?(?:www\.)?[a-z0-9-]+\.[a-z]{2,}[^\s]*)/i,
              );
              if (!matched) return null;

              const url = toCandidateUrl(matched[1]);
              if (!url) return null;

              return {
                url,
                title: null,
                subtitle: line,
              };
            })
            .filter(Boolean);
        };

        const parseFollowers = () => {
          const candidates = [
            document
              .querySelector('meta[property="og:description"]')
              ?.getAttribute("content"),
            textOf("header section ul"),
            textOf("main"),
          ].filter(Boolean);

          for (const source of candidates) {
            const match = source.match(/([\d.,]+\s*[kKmM]?)\s+Followers/);
            if (match) return match[1].trim();
          }

          return null;
        };

        const parseUsernameFromMeta = () => {
          const source =
            document
              .querySelector('meta[property="og:description"]')
              ?.getAttribute("content") || "";

          const match = source.match(/\(@([^\)]+)\)/);
          return match?.[1]?.trim() || null;
        };

        const parseBioFromMeta = () => {
          const source =
            document
              .querySelector('meta[property="og:description"]')
              ?.getAttribute("content") || "";

          const match = source.match(/Instagram:\s*"([\s\S]+)"/i);
          return match?.[1]?.trim() || null;
        };

        const getCategory = () => {
          const candidates = Array.from(
            document.querySelectorAll(
              "header section div[dir='auto'], header div[dir='auto']",
            ),
          )
            .map((element) => element.textContent?.trim() || "")
            .filter(Boolean);

          return (
            candidates.find(
              (line) =>
                !/@/.test(line) &&
                !/followers|following|posts/i.test(line) &&
                !/https?:\/\//i.test(line),
            ) || null
          );
        };

        const getBio = () => {
          const normalize = (value) =>
            value
              .replace(/\u00a0/g, " ")
              .replace(/\n{3,}/g, "\n\n")
              .replace(/\s*(\.\.\.|…)\s*more$/i, "")
              .replace(/\n+/g, " ")
              .replace(/\s{2,}/g, " ")
              .trim();

          const candidates = Array.from(
            document.querySelectorAll(
              "header section div[role='button'] span[dir='auto'], header section span[dir='auto'], header div[role='button'] span[dir='auto'], header span[dir='auto']",
            ),
          )
            .map((element) =>
              normalize(element.innerText || element.textContent || ""),
            )
            .filter(Boolean)
            .filter((line) => !/followers|following|posts/i.test(line))
            .filter((line) => !/followed by/i.test(line))
            .filter((line) => !/and\s+\d+\s+more/i.test(line))
            .filter(
              (line) => !/^https?:\/\//i.test(line) && !/^www\./i.test(line),
            )
            .sort((a, b) => b.length - a.length);

          return candidates[0] || null;
        };

        const links = extractLinksFromModal();
        const collapsedLinks = extractCollapsedLinksText();
        const mergedLinks = [...links, ...collapsedLinks].filter(
          (entry, idx, arr) =>
            arr.findIndex((candidate) => candidate.url === entry.url) === idx,
        );

        const primaryExternalUrl =
          mergedLinks.find((entry) => entry.url.includes("l.instagram.com/?u="))
            ?.url ||
          mergedLinks.find((entry) => /^https?:\/\//i.test(entry.url))?.url ||
          pickExternalUrl();

        return {
          username:
            textOf("header h2") ||
            textOf("main header h1") ||
            document.location.pathname.split("/").filter(Boolean)[0] ||
            null,
          meta_username: parseUsernameFromMeta(),
          full_name:
            textOf("header section h1") ||
            textOf("h1") ||
            document
              .querySelector('meta[property="og:title"]')
              ?.getAttribute("content")
              ?.split("(")[0]
              ?.trim() ||
            null,
          category: getCategory(),
          bio:
            getBio() ||
            parseBioFromMeta() ||
            textOf("header section div.-vDIg span") ||
            textOf("header section div span") ||
            null,
          followers: parseFollowers(),
          external_url: toCandidateUrl(primaryExternalUrl || "") || null,
          links: mergedLinks,
        };
      });

      const candidateUsername =
        extracted.meta_username || extracted.username || requestedUsername;

      const blockedUsernames = new Set([
        "accounts",
        "login",
        "emailsignup",
        "challenge",
      ]);
      const normalizedUsername = blockedUsernames.has(
        (candidateUsername || "").toLowerCase(),
      )
        ? requestedUsername
        : candidateUsername;

      profile = {
        source_url: request.loadedUrl || request.url,
        username: normalizedUsername || null,
        full_name: extracted.full_name || null,
        category: extracted.category || null,
        bio: extracted.bio || null,
        followers: extracted.followers || null,
        external_url: extracted.external_url || null,
        links: Array.isArray(extracted.links) ? extracted.links : [],
      };

      delete profile.meta_username;

      if (!profile.username && !profile.full_name && !profile.bio) {
        throw new Error("profile-data-not-found");
      }
    },
    failedRequestHandler: ({ request }) => {
      profile = {
        source_url: request.url,
        username: null,
        full_name: null,
        bio: null,
        category: null,
        followers: null,
        external_url: null,
        links: [],
      };
    },
  });

  await crawler.run([
    {
      url: normalizedUrl,
      uniqueKey: `${normalizedUrl}::${Date.now()}`,
    },
  ]);

  if (authRequired) {
    const authResponse = {
      code: 401,
      success: false,
      message: "instagram-authentication-required",
      data: {
        profile: null,
        deep_scan: {
          skipped: true,
          reason: "temporarily-disabled",
          source_url: null,
          emails: [],
          phone_numbers: [],
          html_title: null,
        },
      },
    };

    console.log(
      "instagram-scrape-response",
      JSON.stringify(authResponse, null, 2),
    );
    return authResponse;
  }

  if (!profile || (!profile.username && !profile.full_name && !profile.bio)) {
    const failedResponse = {
      code: 422,
      success: false,
      message: "unable-to-extract-instagram-profile-data",
      data: {
        profile,
        deep_scan: {
          source_url: null,
          emails: [],
          phone_numbers: [],
          html_title: null,
        },
      },
    };

    console.log(
      "instagram-scrape-response",
      JSON.stringify(failedResponse, null, 2),
    );

    return {
      ...failedResponse,
    };
  }

  const deepScan = await deepScanExternalUrl(profile.external_url);

  const successResponse = {
    code: 200,
    success: true,
    message: "instagram-profile-scraped-successfully",
    data: {
      profile,
      deep_scan: deepScan,
    },
  };

  console.log(
    "instagram-scrape-response",
    JSON.stringify(successResponse, null, 2),
  );

  return successResponse;
};

const InstagramService = {
  scrapeInstagramProfile,
};

export default InstagramService;
