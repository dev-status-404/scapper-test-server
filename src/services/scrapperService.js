import puppeteer from "puppeteer";
import Lead from "../models/lead.model.js"; // adjust path
import InstagramService from "./instaService.js";
import { extractEmails } from "../utils/extractor.js";
import fs from "fs";
import { randomUUID } from "crypto";
import userLeadService from "./userLeadService.js";
import { scrapeWithApify } from "./instagram/integrations/apify.js";

const cookies = JSON.parse(fs.readFileSync("./linkedin.cookies.json", "utf-8"));
// const SIGNALHIRE_API_KEY = "202.Jin2HYFBK7vW9GGvK6CoNuMz2Uu8";
const SIGNALHIRE_API_KEY = process.env.SIGNALHIRE_API_KEY;

if (!SIGNALHIRE_API_KEY) {
  console.warn(
    "⚠️  WARNING: SIGNALHIRE_API_KEY not set in environment variables",
  );
}

const splitName = (fullName) => {
  console.log("fullName", fullName);
  if (!fullName || typeof fullName !== "string") {
    return {
      first_name: null,
      last_name: null,
    };
  }

  const parts = fullName.trim().split(" ");
  return {
    first_name: parts[0] || null,
    last_name: parts.slice(1).join(" ") || null,
  };
};

const toCleanArray = (value) => {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }

  return [];
};

const uniqueValues = (values) => [...new Set(values.filter(Boolean))];

const parseCount = (value) => {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const text = String(value).trim().toLowerCase();
  if (!text) {
    return null;
  }

  const normalized = text.replace(/,/g, "");
  const match = normalized.match(/^(\d+(?:\.\d+)?)([km])?$/i);
  if (!match) {
    const digitsOnly = normalized.replace(/[^\d]/g, "");
    return digitsOnly ? Number(digitsOnly) : null;
  }

  const base = Number(match[1]);
  const suffix = match[2]?.toLowerCase();

  if (suffix === "k") {
    return Math.round(base * 1000);
  }

  if (suffix === "m") {
    return Math.round(base * 1000000);
  }

  return Math.round(base);
};

const runInstagramServiceFallback = async ({
  profileUrl,
  user_id,
  folder_id,
}) => {
  const instagramResponse = await InstagramService.scrapeInstagramProfile({
    profileUrl,
  });
  const profile = instagramResponse?.data?.profile || null;
  const deepScan = instagramResponse?.data?.deep_scan || null;

  if (!instagramResponse?.success || !profile) {
    return {
      code: instagramResponse?.code || 500,
      success: false,
      message: "instagram-service-fallback-failed",
      data: instagramResponse?.data || null,
    };
  }

  const { first_name, last_name } = splitName(profile?.full_name);
  const emails = uniqueValues([
    ...extractEmails(profile?.bio),
    ...toCleanArray(deepScan?.emails),
  ]);
  const phoneNumbers = uniqueValues([...toCleanArray(deepScan?.phone_numbers)]);
  const externalUrls = uniqueValues(
    [
      profile?.external_url,
      ...(Array.isArray(profile?.links)
        ? profile.links.map((entry) => entry?.url)
        : []),
    ]
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean),
  );

  const leadPayload = {
    first_name,
    last_name,
    company: profile?.username || "",
    emails,
    phone_numbers: phoneNumbers,
    message: `
Instagram Profile Scraped

Username: ${profile?.username || "N/A"}
Full Name: ${profile?.full_name || "N/A"}
Bio: ${profile?.bio || "N/A"}
Followers: ${profile?.followers || "N/A"}
Following: ${profile?.following || "N/A"}
Profile URL: ${profile?.source_url || profileUrl}
    `.trim(),
    source_url: profile?.source_url || profileUrl,
    source_rul: profile?.source_url || profileUrl,
    instagram_profile_id: profile?.id || null,
    username: profile?.username || null,
    full_name: profile?.full_name || null,
    bio: profile?.bio || null,
    avatar_url: profile?.avatar_url || null,
    avatar_rul: profile?.avatar_url || null,
    followers: parseCount(profile?.followers),
    following: parseCount(profile?.following),
    follower_count: parseCount(profile?.followers),
    following_count: parseCount(profile?.following),
    total_posts: parseCount(profile?.posts),
    category: profile?.category || null,
    external_url: profile?.external_url || null,
    external_url_linkshimmed: profile?.external_url_linkshimmed || null,
    external_urls: externalUrls,
    is_private:
      typeof profile?.is_private === "boolean" ? profile.is_private : null,
    is_verified:
      typeof profile?.is_verified === "boolean" ? profile.is_verified : null,
    is_public:
      typeof profile?.is_private === "boolean" ? !profile.is_private : null,
    fb_profile_biolink: profile?.fb_profile_biolink || null,
    highlight_reel_count: parseCount(profile?.highlight_reel_count),
    links: Array.isArray(profile?.links) ? profile.links : [],
    scrape_status: true,
    type: "INSTAGRAM",
  };

  const { lead, fromCache } = await userLeadService.resolveOrCreateLead(
    leadPayload,
    { user_id, folder_id, type: "INSTAGRAM" },
  );

  return {
    code: 200,
    success: true,
    message: fromCache ? "instagram-profile-fetched-from-cache" : "instagram-service-fallback-success",
    from_cache: fromCache,
    data: {
      lead,
      profile,
      deep_scan: deepScan,
    },
  };
};

const scrapeInstagramProfile = async ({ profileUrl, user_id, folder_id }) => {
  console.log("profileUrl", profileUrl);
  if (!profileUrl) {
    return {
      code: 400,
      success: false,
      message: "instagram-profile-URL-is-required",
    };
  }

  let browser;

  try {
    browser = await puppeteer.launch({
      headless: false, // Show browser window
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
        "--disable-blink-features=AutomationControlled",
      ],
    });

    const page = await browser.newPage();

    // Hide automation indicators
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", {
        get: () => undefined,
      });
    });

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );

    // Set viewport for better rendering
    await page.setViewport({ width: 1366, height: 768 });

    // Try to load Instagram cookies if they exist
    try {
      const fs = await import("fs");
      if (fs.existsSync("./instagram.cookies.json")) {
        const cookies = JSON.parse(
          fs.readFileSync("./instagram.cookies.json", "utf-8"),
        );
        await page.setCookie(...cookies);
        console.log("Instagram cookies loaded");
      }
    } catch (cookieError) {
      console.log(
        "No Instagram cookies found, proceeding without authentication",
      );
    }

    await page.goto(profileUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    // Check if login page is shown
    const isLoginPage = await page.evaluate(() => {
      return document.querySelector('input[name="username"]') !== null;
    });

    if (isLoginPage) {
      throw new Error(
        "Instagram requires login to view this profile. Please add instagram.cookies.json file with authenticated cookies.",
      );
    }

    // Check if content is blocked
    const isContentBlocked = await page.evaluate(() => {
      const blockedText = document.body.innerText.toLowerCase();
      return (
        blockedText.includes("login") ||
        blockedText.includes("sign up") ||
        blockedText.includes("private account") ||
        document.querySelector(".login-form") !== null
      );
    });

    if (isContentBlocked) {
      throw new Error(
        "Instagram content is blocked. This profile may be private or requires authentication.",
      );
    }

    // Wait for content to load with multiple fallback strategies
    let profileData = null;

    try {
      // Try multiple selector strategies
      const strategies = [
        { selector: "header", timeout: 8000 },
        { selector: "article", timeout: 5000 },
        { selector: "main", timeout: 5000 },
        { selector: "[role='main']", timeout: 5000 },
      ];

      for (const strategy of strategies) {
        try {
          await page.waitForSelector(strategy.selector, {
            timeout: strategy.timeout,
          });
          console.log(`Found selector: ${strategy.selector}`);
          break;
        } catch (error) {
          console.log(
            `Selector ${strategy.selector} not found, trying next...`,
          );
        }
      }
    } catch (error) {
      console.log("All selectors failed, proceeding with extraction anyway");
    }

    // Add delay for content to render
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Take screenshot for debugging
    try {
      // await page.screenshot({ path: 'instagram-debug.png', fullPage: true });
      console.log("Debug screenshot saved as instagram-debug.png");
    } catch (screenshotError) {
      console.log("Could not take screenshot");
    }

    profileData = await page.evaluate(() => {
      const getText = (selector) => {
        try {
          const element = document.querySelector(selector);
          return element?.innerText?.trim() || null;
        } catch (e) {
          return null;
        }
      };

      const getAttribute = (selector, attribute) => {
        try {
          const element = document.querySelector(selector);
          return element?.[attribute] || null;
        } catch (e) {
          return null;
        }
      };

      // More comprehensive selector strategies
      const username =
        getText("header h2") ||
        getText("h1") ||
        getText("[class*='username']") ||
        getText("[class*='user']") ||
        document.title?.split("•")[0]?.trim() ||
        null;

      const fullName =
        getText("header section h1") ||
        getText("h1") ||
        getText("[class*='name']") ||
        getText("[class*='title']") ||
        getText("[class*='full-name']") ||
        getText("[class*='profile-name']") ||
        getText("[class*='user-name']") ||
        getText("span[class*='username']") ||
        getText("div[class*='username']") ||
        getText("a[class*='username']") ||
        getText("h2") ||
        document
          .querySelector('meta[property="og:title"]')
          ?.content?.split("•")[0]
          ?.trim() ||
        document.querySelector("title")?.text?.split("•")[0]?.trim() ||
        document
          .querySelector('meta[name="title"]')
          ?.content?.split("•")[0]
          ?.trim() ||
        null;

      const bio =
        getText("header section div span") ||
        getText("div[class*='bio']") ||
        getText("[class*='description']") ||
        getText("[class*='about']") ||
        null;

      // Try to find stats in multiple ways
      let posts = null,
        followers = null,
        following = null;

      // Method 1: Original selector
      const stats1 = document.querySelectorAll(
        "header section ul li span span",
      );
      if (stats1.length >= 3) {
        posts = stats1[0]?.innerText;
        followers = stats1[1]?.innerText;
        following = stats1[2]?.innerText;
      }

      // Method 2: Look for numbers with labels
      if (!posts || !followers || !following) {
        const allSpans = document.querySelectorAll("span");
        const numbers = [];
        allSpans.forEach((span) => {
          const text = span.innerText.trim();
          if (/^\d+[,\d]*$/.test(text) || /^\d+[kKmM]+$/.test(text)) {
            numbers.push(text);
          }
        });
        if (numbers.length >= 3) {
          posts = numbers[0];
          followers = numbers[1];
          following = numbers[2];
        }
      }

      const profileImage =
        getAttribute("header img", "src") ||
        getAttribute("img[alt*='profile']", "src") ||
        getAttribute("img[class*='avatar']", "src") ||
        getAttribute("meta[property='og:image']", "content") ||
        null;

      return {
        username,
        fullName,
        bio,
        posts,
        followers,
        following,
        profileImage,
      };
    });

    // More flexible validation
    if (!profileData.username && !profileData.fullName && !profileData.bio) {
      throw new Error(
        "Unable to extract profile information. The profile may be private, deleted, or requires authentication. Check instagram-debug.png for visual confirmation.",
      );
    }

    const { first_name, last_name } = splitName(profileData.fullName);
    const emails = extractEmails(profileData.bio);

    /** -----------------------------
     * Create or reuse Lead Document (dedup-aware)
     * ----------------------------- */
    const { lead, fromCache } = await userLeadService.resolveOrCreateLead(
      {
        first_name,
        last_name,
        company: profileData.username,
        emails,
        username: profileData.username || null,
        message: `
Instagram Profile Scraped

Username: ${profileData.username || "N/A"}
Full Name: ${profileData.fullName || "N/A"}
Bio: ${profileData.bio || "N/A"}
Followers: ${profileData.followers || "N/A"}
Following: ${profileData.following || "N/A"}
Posts: ${profileData.posts || "N/A"}
Profile URL: ${profileUrl}
        `.trim(),
        scrape_status: true,
        type: "INSTAGRAM",
      },
      { user_id, folder_id, type: "INSTAGRAM" },
    );

    return {
      code: 200,
      success: true,
      from_cache: fromCache,
      data: {
        lead,
      },
    };
  } catch (error) {
    console.log("error sssssssssssssss", error);
    return {
      code: 500,
      success: false,
      message: "failed-to-scrape-and-save-instagram-profile",
      error: error.message || error,
    };
  } finally {
    if (browser) await browser.close();
  }
};

const scrapeLinkedInProfileV2 = async ({ profileUrl, user_id, folder_id }) => {
  try {
    const response = await scrapeLinkedInProfile({
      profileUrl,
      user_id,
      folder_id,
    });

    // Here you would typically save the response data to your database
    // For example:
    // await LinkedInProfile.create({
    //   user_id,
    //   folder_id,
    //   profile_url: profileUrl,
    //   data: response.data,
    // });

    return response;
  } catch (error) {
    console.error("Error in scrapeLinkedInProfileV2:", error);
    return {
      code: 500,
      success: false,
      message: "failed-to-scrape-linkedin-profile",
      error: error.message || error,
    };
  }
};

const scrapeLinkedInProfile = async ({
  profileUrl,
  user_id,
  folder_id,
  res,
}) => {
  try {
    const uuid = randomUUID();

    const linkedinUrl = profileUrl;

    // if (!linkedinUrl || !linkedinUrl.startsWith("https://www.linkedin.com")) {
    //   return res.status(400).send({ error: "Valid LinkedIn URL required" });
    // }

    // Prepare request
    const payload = {
      items: [linkedinUrl], // Array of items — LinkedIn URL(s)
      callbackUrl: `${process.env.API_BASE_URL || process.env.APP_URL || process.env.BASE_URL || "https://api.dataharvx.com"}/api/scrapper/signalhire-callback?user_id=${user_id}&folder_id=${folder_id}&scrape_id=${uuid}`,
    };

    // Make request
    const response = await fetch(
      "https://www.signalhire.com/api/v1/candidate/search",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SIGNALHIRE_API_KEY,
        },
        body: JSON.stringify(payload),
      },
    );

    const data = await response.json();

    data.scrape_id = uuid;

    // If using callbackUrl, SignalHire posts results later; here we just show initial
    return {
      code: 200,
      success: true,
      data: data,
    };
  } catch (error) {
    console.error(error.response?.data || error.message);
    throw error;
  }
};

const scrapeInstagramProfileV2 = async ({ profileUrl, user_id, folder_id }) => {
  try {
    const item = await scrapeWithApify(profileUrl);
    // const item = null; // Simulate no data found to trigger fallback
    if (!item) {
      return runInstagramServiceFallback({ profileUrl, user_id, folder_id });
    }

    const extractedEmails = toCleanArray(item?.ExtractedEmails);
    const publicEmails = toCleanArray(item?.public_email);
    const bioEmails = extractEmails(item?.biography);
    const emails = uniqueValues([
      ...bioEmails,
      ...publicEmails,
      ...extractedEmails,
    ]);

    const extractedPhones = toCleanArray(item?.ExtractedPhones);
    const directPhones = uniqueValues(
      [
        item?.contact_phone_number,
        item?.public_phone_number,
        item?.public_phone_country_code && item?.public_phone_number
          ? `+${item.public_phone_country_code}${item.public_phone_number}`
          : null,
      ]
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter(Boolean),
    );
    const phoneNumbers = uniqueValues([...directPhones, ...extractedPhones]);

    const { first_name, last_name } = splitName(item?.full_name);

    const leadPayload = {
      first_name,
      last_name,
      company: item?.username || "",
      message: `
Instagram Profile Scraped

Username: ${item?.username || ""}
Full Name: ${item?.full_name || ""}
Bio: ${item?.biography || ""}
Followers: ${item?.followers_count || ""}
Following: ${item?.following_count || ""}
Posts: ${item?.media_count || ""}
Profile URL: ${profileUrl}
      `.trim(),
      emails,
      phone_numbers: phoneNumbers,
      source_url: item?.URL || profileUrl,
      source_rul: item?.URL || profileUrl,
      instagram_profile_id: item?.pk ? String(item.pk) : null,
      username: item?.username || null,
      full_name: item?.full_name || null,
      bio: item?.biography || null,
      avatar_url: item?.profile_pic_url || null,
      avatar_rul: item?.profile_pic_url || null,
      followers: parseCount(item?.follower_count),
      following: parseCount(item?.following_count),
      follower_count: parseCount(item?.follower_count),
      following_count: parseCount(item?.following_count),
      total_posts: parseCount(item?.total_posts ?? item?.media_count),
      category: item?.category || item?.category_name || null,
      external_url: item?.external_url || null,
      is_private:
        typeof item?.is_private === "boolean"
          ? item.is_private
          : typeof item?.is_business === "boolean"
            ? !item.is_business
            : null,
      is_verified:
        typeof item?.is_verified === "boolean" ? item.is_verified : null,
      is_public:
        typeof item?.is_private === "boolean" ? !item.is_private : null,
      scrape_status: true,
      type: "INSTAGRAM",
    };

    const { lead, fromCache } = await userLeadService.resolveOrCreateLead(
      leadPayload,
      { user_id, folder_id, type: "INSTAGRAM" },
    );

    return {
      code: 200,
      success: true,
      from_cache: fromCache,
      data: {
        lead,
      },
    };
  } catch (error) {
    console.error(error);
    return runInstagramServiceFallback({ profileUrl, user_id, folder_id });
  }
};

const scrapperService = {
  scrapeInstagramProfile,
  scrapeLinkedInProfile,
  scrapeInstagramProfileV2,
};

export default scrapperService;
