import { stripeService } from "./stripeService.js";

const toPositiveInteger = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
};

export const getRemainingCredits = (subscription) => {
  if (!subscription) {
    return 0;
  }

  return Math.max(
    0,
    toPositiveInteger(subscription.credits_total) -
      toPositiveInteger(subscription.credits_used),
  );
};

export const reserveScrapedProfileCredits = async (userId, count) => {
  const amount = toPositiveInteger(count);
  if (amount === 0) {
    return 0;
  }

  if (!userId) {
    throw Object.assign(new Error("user_id is required for credit deduction"), {
      statusCode: 400,
    });
  }

  await stripeService.deductCredits(userId, amount);
  return amount;
};

export const refundUnusedScrapedProfileCredits = async (
  userId,
  reservedCount,
  usedCount,
) => {
  const unusedCount =
    toPositiveInteger(reservedCount) - toPositiveInteger(usedCount);

  if (unusedCount <= 0) {
    return null;
  }

  return stripeService.refundCredits(userId, unusedCount);
};
