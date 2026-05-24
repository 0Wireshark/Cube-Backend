const functions = require("./functions.js");

function ensureRefreshQueues() {
  if (!global.profileRefresh) global.profileRefresh = {};
  if (!global.giftReceived) global.giftReceived = {};
}

function queueAthenaRefresh(accountId, eventType = "com.epicgames.gift.received") {
  if (!accountId) return;

  ensureRefreshQueues();
  global.profileRefresh[accountId] = {
    ...(global.profileRefresh[accountId] || {}),
    athena: true,
  };

  functions.sendXmppMessageToId(
    {
      type: eventType,
      payload: {},
      timestamp: new Date().toISOString(),
    },
    accountId,
  );
}

function queueGiftRefresh(accountId) {
  if (!accountId) return;

  ensureRefreshQueues();
  global.giftReceived[accountId] = true;
  queueAthenaRefresh(accountId);
}

module.exports = {
  queueAthenaRefresh,
  queueGiftRefresh,
};
