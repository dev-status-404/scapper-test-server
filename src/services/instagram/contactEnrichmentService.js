import { extractEmails, extractPhones, extractUrls } from "../../utils/extractor.js";
import { normalizeExternalUrl } from "./normalizers.js";

const normalizeEmails = (emails = []) =>
  [
    ...new Set(
      emails
        .map((email) => String(email || "").trim().toLowerCase())
        .filter(Boolean),
    ),
  ];

const normalizePhones = (phones = []) =>
  [
    ...new Set(
      phones.map((phone) => String(phone || "").trim()).filter(Boolean),
    ),
  ];

const toArray = (value) => {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
};

const collectLinkUrls = (links = []) =>
  links
    .map((link) => (typeof link === "string" ? link : link?.url))
    .filter(Boolean);

const collectProfileRaw = (profile = {}) =>
  profile.raw_profile || profile.raw || null;

export const collectProfileExternalUrls = (profile = {}) => {
  const raw = collectProfileRaw(profile);
  const bioText = [
    profile.bio,
    profile.biography,
    raw?.bio,
    raw?.biography,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("\n");

  return [
    ...new Set(
      [
        profile.external_url,
        ...(Array.isArray(profile.external_urls) ? profile.external_urls : []),
        ...extractUrls(bioText),
        ...collectLinkUrls(profile.links || []),
        profile.fb_profile_biolink?.url,
        raw?.externalUrl,
        raw?.external_url,
        ...(Array.isArray(raw?.externalUrls)
          ? raw.externalUrls.map((entry) =>
              typeof entry === "string" ? entry : entry?.url,
            )
          : []),
        ...(Array.isArray(raw?.bio_links)
          ? raw.bio_links.map((entry) =>
              typeof entry === "string" ? entry : entry?.url,
            )
          : []),
      ]
        .map((url) => normalizeExternalUrl(url))
        .filter(Boolean),
    ),
  ];
};

export const extractContactSnapshotFromProfile = (profile = {}) => {
  const raw = collectProfileRaw(profile);
  const bio = String(profile.bio || profile.biography || "");
  const emails = normalizeEmails([
    ...extractEmails(bio),
    ...toArray(profile.contacts?.emails),
    ...toArray(profile.emails),
    profile.business_email,
    raw?.businessEmail,
    raw?.business_email,
    raw?.email,
    ...toArray(raw?.emails),
  ]);
  const phoneNumbers = normalizePhones([
    ...extractPhones(bio),
    ...toArray(profile.contacts?.phone_numbers),
    ...toArray(profile.contacts?.phones),
    ...toArray(profile.phone_numbers),
    profile.business_phone_number,
    raw?.businessPhoneNumber,
    raw?.business_phone_number,
    raw?.phone,
    ...toArray(raw?.phone_numbers),
  ]);
  const externalUrls = collectProfileExternalUrls(profile);

  return {
    emails,
    phone_numbers: phoneNumbers,
    external_url: externalUrls[0] || null,
    external_urls: externalUrls,
    links: Array.isArray(profile.links)
      ? profile.links
      : Array.isArray(raw?.externalUrls)
        ? raw.externalUrls
        : Array.isArray(raw?.bio_links)
          ? raw.bio_links
          : [],
  };
};

export const applyContactSnapshotToProfile = (profile = {}) => {
  const snapshot = extractContactSnapshotFromProfile(profile);
  return {
    ...profile,
    emails: snapshot.emails,
    phone_numbers: snapshot.phone_numbers,
    external_url: snapshot.external_url,
    external_urls: snapshot.external_urls,
    links: snapshot.links,
  };
};

export const buildDeepScanTargetsForLeads = (leads = []) => {
  const targets = [];
  const seen = new Set();

  for (const lead of leads) {
    const leadId = lead?._id ? String(lead._id) : null;
    if (!leadId) continue;

    for (const url of collectProfileExternalUrls(lead)) {
      const dedupeKey = `${leadId}:${url}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      targets.push({
        lead_id: leadId,
        url,
      });
    }
  }

  return targets;
};

export default {
  applyContactSnapshotToProfile,
  buildDeepScanTargetsForLeads,
  collectProfileExternalUrls,
  extractContactSnapshotFromProfile,
};
