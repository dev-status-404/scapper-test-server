import { extractUrls } from "../../utils/extractor.js";
import { ProviderInvalidInputError } from "./errors.js";

const RESERVED_INSTAGRAM_PATHS = new Set([
  "about",
  "accounts",
  "api",
  "developer",
  "direct",
  "explore",
  "oauth",
  "p",
  "reel",
  "reels",
  "stories",
  "tv",
]);

const INSTAGRAM_HOST_PATTERN = /(^|\.)instagram\.com$/i;
const USERNAME_PATTERN = /^[a-z0-9._]{1,30}$/;

const toStringOrNull = (value) => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
};

const parseNumber = (value) => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  const text = String(value).trim().toLowerCase().replace(/,/g, "");
  const match = text.match(/^(\d+(?:\.\d+)?)([km])?$/i);
  if (!match) {
    const digitsOnly = text.replace(/[^\d]/g, "");
    return digitsOnly ? Number(digitsOnly) : null;
  }

  const number = Number(match[1]);
  if (!Number.isFinite(number)) return null;
  if (match[2]?.toLowerCase() === "k") return Math.round(number * 1000);
  if (match[2]?.toLowerCase() === "m") return Math.round(number * 1000000);
  return Math.round(number);
};

const toArray = (value) => {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
};

export const normalizeInstagramUsername = (input) => {
  const original = toStringOrNull(input);
  if (!original) {
    throw new ProviderInvalidInputError("instagram-username-required");
  }

  let candidate = original.trim();

  if (candidate.startsWith("@")) {
    candidate = candidate.slice(1);
  }

  if (/^https?:\/\//i.test(candidate)) {
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new ProviderInvalidInputError("invalid-instagram-url", {
        metadata: { input: original },
      });
    }

    if (!INSTAGRAM_HOST_PATTERN.test(parsed.hostname)) {
      throw new ProviderInvalidInputError("invalid-instagram-host", {
        metadata: { hostname: parsed.hostname },
      });
    }

    candidate = parsed.pathname.split("/").filter(Boolean)[0] || "";
  } else {
    candidate = candidate.split("?")[0].split("#")[0].replace(/^\/+|\/+$/g, "");
  }

  candidate = candidate.toLowerCase();

  if (
    !USERNAME_PATTERN.test(candidate) ||
    candidate.includes("..") ||
    candidate.startsWith(".") ||
    candidate.endsWith(".") ||
    RESERVED_INSTAGRAM_PATHS.has(candidate)
  ) {
    throw new ProviderInvalidInputError("invalid-instagram-username", {
      metadata: { input: original },
    });
  }

  return candidate;
};

export const normalizeExternalUrl = (url) => {
  const raw = toStringOrNull(url);
  if (!raw) return null;

  try {
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const parsed = new URL(withScheme);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
};

export const normalizeContactData = ({ emails = [], phones = [] } = {}) => ({
  emails: [...new Set((emails || []).map((email) => String(email).trim().toLowerCase()).filter(Boolean))],
  phone_numbers: [...new Set((phones || []).map((phone) => String(phone).trim()).filter(Boolean))],
});

export const normalizeRelationshipUser = (raw = {}, source = "unknown") => {
  const username = raw.username ? normalizeInstagramUsername(raw.username) : null;

  return {
    source,
    instagram_profile_id: toStringOrNull(raw.id ?? raw.pk ?? raw.instagram_profile_id),
    username,
    full_name: toStringOrNull(raw.full_name ?? raw.fullName),
    is_private:
      typeof raw.is_private === "boolean"
        ? raw.is_private
        : typeof raw.private === "boolean"
          ? raw.private
          : null,
    is_verified:
      typeof raw.is_verified === "boolean"
        ? raw.is_verified
        : typeof raw.verified === "boolean"
          ? raw.verified
          : null,
    avatar_url: toStringOrNull(
      raw.profile_pic_url ?? raw.profilePicUrlHD ?? raw.profilePicUrl ?? raw.avatar_url,
    ),
    raw,
  };
};

export const normalizeInstagramProfile = (raw = {}, source = "unknown") => {
  const usernameValue = raw.username ?? raw.userName ?? raw.handle;
  const username = usernameValue ? normalizeInstagramUsername(usernameValue) : null;
  const externalUrls = [
    raw.externalUrl,
    raw.external_url,
    ...extractUrls(raw.biography ?? raw.bio ?? ""),
    ...(Array.isArray(raw.externalUrls)
      ? raw.externalUrls.map((entry) => (typeof entry === "string" ? entry : entry?.url))
      : []),
  ]
    .map(normalizeExternalUrl)
    .filter(Boolean);
  const contacts = normalizeContactData({
    emails: [raw.businessEmail, raw.business_email, raw.email, ...toArray(raw.emails)],
    phones: [
      raw.businessPhoneNumber,
      raw.business_phone_number,
      raw.phone,
      ...toArray(raw.phone_numbers),
    ],
  });

  return {
    source,
    instagram_profile_id: toStringOrNull(raw.id ?? raw.userId ?? raw.pk),
    username,
    full_name: toStringOrNull(raw.fullName ?? raw.full_name),
    bio: toStringOrNull(raw.biography ?? raw.bio) || "",
    avatar_url: toStringOrNull(
      raw.profilePicUrlHD ?? raw.profile_pic_url_hd ?? raw.profilePicUrl ?? raw.profile_pic_url,
    ),
    followers: parseNumber(raw.followersCount ?? raw.followers_count ?? raw.follower_count),
    following: parseNumber(
      raw.followsCount ?? raw.followingCount ?? raw.follows_count ?? raw.following_count,
    ),
    total_posts: parseNumber(raw.postsCount ?? raw.posts_count ?? raw.media_count),
    category: toStringOrNull(raw.businessCategoryName ?? raw.business_category_name ?? raw.category),
    external_url: externalUrls[0] || null,
    external_urls: externalUrls,
    external_url_linkshimmed: toStringOrNull(raw.externalUrlShimmed),
    is_private:
      typeof raw.private === "boolean"
        ? raw.private
        : typeof raw.is_private === "boolean"
          ? raw.is_private
          : null,
    is_verified:
      typeof raw.verified === "boolean"
        ? raw.verified
        : typeof raw.is_verified === "boolean"
          ? raw.is_verified
          : null,
    links: Array.isArray(raw.externalUrls) ? raw.externalUrls : [],
    contacts,
    source_url: toStringOrNull(raw.url) || (username ? `https://www.instagram.com/${username}` : null),
    raw,
  };
};
