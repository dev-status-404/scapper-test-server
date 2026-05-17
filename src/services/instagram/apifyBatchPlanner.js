const normalizeJobType = (value) => {
  const normalized = String(value || "single_profile").trim().toLowerCase();
  if (["single_profile", "bulk_profiles", "followers", "following"].includes(normalized)) {
    return normalized;
  }
  return "single_profile";
};

export const normalizeAndDedupeUsernames = (usernames = []) => {
  const out = [];
  const seen = new Set();

  for (const entry of usernames) {
    const normalized = String(entry || "")
      .trim()
      .replace(/^@+/, "")
      .toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }

  return out;
};

export const chunkUsernames = (usernames, chunkSize) => {
  const chunks = [];
  const safeChunkSize = Math.max(1, Number.parseInt(chunkSize, 10) || 1);

  for (let index = 0; index < usernames.length; index += safeChunkSize) {
    chunks.push(usernames.slice(index, index + safeChunkSize));
  }

  return chunks;
};

export const buildApifyEnrichmentPlan = ({
  usernames,
  context,
  chunkSize = 100,
  maxChunkSize = 500,
  cachedUsernames = [],
  budgetUsd,
  estimatedCostPerItemUsd = 0.002,
  allowSingleAsFinalLeftover = false,
}) => {
  const normalizedContext = {
    jobType: normalizeJobType(context?.jobType),
    jobId: context?.jobId || null,
    userId: context?.userId || null,
  };

  const dedupedUsernames = normalizeAndDedupeUsernames(usernames);
  const cachedSet = new Set(normalizeAndDedupeUsernames(cachedUsernames));
  const uncachedUsernames = dedupedUsernames.filter((username) => !cachedSet.has(username));

  const safeChunkSize = Math.max(
    1,
    Math.min(Number.parseInt(chunkSize, 10) || 100, Number.parseInt(maxChunkSize, 10) || 500),
  );

  const estimatedCost = Number(
    (Math.max(0, uncachedUsernames.length) * (Number(estimatedCostPerItemUsd) || 0.002)).toFixed(6),
  );

  const effectiveBudget =
    Number.isFinite(Number(budgetUsd)) && Number(budgetUsd) > 0 ? Number(budgetUsd) : 0;

  if (effectiveBudget > 0 && estimatedCost > effectiveBudget) {
    return {
      context: normalizedContext,
      dedupedUsernames,
      uncachedUsernames,
      chunks: [],
      estimatedCost,
      budgetUsd: effectiveBudget,
      stage: "SKIPPED_COST_LIMIT",
    };
  }

  const chunks = chunkUsernames(uncachedUsernames, safeChunkSize);

  if (
    ["followers", "following", "bulk_profiles"].includes(normalizedContext.jobType) &&
    uncachedUsernames.length === 1 &&
    !allowSingleAsFinalLeftover
  ) {
    throw new Error(
      "Apify single-profile enrichment called inside relationship job. This is inefficient. Use batch enrichment.",
    );
  }

  return {
    context: normalizedContext,
    dedupedUsernames,
    uncachedUsernames,
    chunks,
    estimatedCost,
    budgetUsd: effectiveBudget,
    stage: "READY",
  };
};
