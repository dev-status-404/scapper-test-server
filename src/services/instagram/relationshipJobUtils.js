import { normalizeInstagramUsername } from "./normalizers.js";
import { normalizeRelationshipRequestType } from "./relationshipTypes.js";

export const normalizeJobSegment = (value, fallback) => {
  const normalized = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || fallback;
};

export const buildRelationshipScrapeJobId = ({
  targetUsername,
  type = "followers",
  user_id,
  folder_id,
}) => {
  const username = normalizeJobSegment(
    targetUsername ? normalizeInstagramUsername(targetUsername) : null,
    "unknown-user",
  );
  const relationship = normalizeJobSegment(normalizeRelationshipRequestType(type), "followers");
  const userId = normalizeJobSegment(user_id, "anonymous");
  const folderId = normalizeJobSegment(folder_id, "no-folder");

  return ["instagram-relationship", userId, folderId, relationship, username].join("__");
};

