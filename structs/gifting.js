const config = require("../Config/config.json");

const CLIENT_GIFT_FRIENDSHIP_DELAY_DAYS = 2;
const CLIENT_DELAY_SAFETY_MS = 60000;

function getFriendshipDelayDays() {
  const value = process.env.CUBE_GIFT_FRIENDSHIP_DELAY_DAYS ?? config.gifting?.friendshipDelayDays ?? 0;
  const days = Number(value);
  return Number.isFinite(days) && days > 0 ? days : 0;
}

function getAcceptedFriendEntry(friends, accountId) {
  const accepted = friends?.list?.accepted;
  if (!Array.isArray(accepted)) return null;
  return accepted.find((entry) => entry?.accountId == accountId) || null;
}

function hasGiftPermission(profile, key) {
  const value = profile?.stats?.attributes?.[key];
  return value !== false;
}

function canSendGifts(commonCoreProfile) {
  return hasGiftPermission(commonCoreProfile, "allowed_to_send_gifts");
}

function canReceiveGifts(commonCoreProfile) {
  return hasGiftPermission(commonCoreProfile, "allowed_to_receive_gifts");
}

function getFriendshipWaitSeconds(friendEntry) {
  const delayDays = getFriendshipDelayDays();
  if (delayDays <= 0) return 0;

  const createdAt = Date.parse(friendEntry?.created || "");
  if (!Number.isFinite(createdAt)) return delayDays * 86400;

  const elapsedMs = Date.now() - createdAt;
  const requiredMs = delayDays * 86400000;
  return Math.max(0, Math.ceil((requiredMs - elapsedMs) / 1000));
}

function getClientGiftEligibleCreated(created) {
  const createdAt = Date.parse(created || "");
  const baseCreatedAt = Number.isFinite(createdAt) ? createdAt : Date.now();
  const configuredDelayDays = getFriendshipDelayDays();
  const backdateDays = Math.max(0, CLIENT_GIFT_FRIENDSHIP_DELAY_DAYS - configuredDelayDays);

  if (backdateDays <= 0) {
    return new Date(baseCreatedAt).toISOString();
  }

  return new Date(baseCreatedAt - backdateDays * 86400000 - CLIENT_DELAY_SAFETY_MS).toISOString();
}

function validateGiftRelationship(friends, senderId, receiverId) {
  if (receiverId == senderId) return { ok: true };

  const friendEntry = getAcceptedFriendEntry(friends, receiverId);
  if (!friendEntry) {
    return { ok: false, reason: "not_friends" };
  }

  const waitSeconds = getFriendshipWaitSeconds(friendEntry);
  if (waitSeconds > 0) {
    return { ok: false, reason: "friendship_too_new", waitSeconds };
  }

  return { ok: true };
}

module.exports = {
  canReceiveGifts,
  canSendGifts,
  getClientGiftEligibleCreated,
  getFriendshipDelayDays,
  validateGiftRelationship,
};
