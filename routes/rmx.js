const express = require("express");
const app = express.Router();

const Friends = require("../model/friends.js");
const log = require("../structs/log.js");

function getOnlineClients() {
  return (global.Clients || [])
    .map((client) => ({
      accountId: client.accountId || "",
      displayName: client.displayName || client.accountId || "",
      status: "online",
    }))
    .filter((client) => client.accountId);
}

function formatFriend(friend) {
  return {
    accountId: friend.accountId,
    displayName: friend.displayName || friend.accountId,
    status: "offline",
  };
}

app.get("/rmx/server/api/v1/clients", (req, res) => {
  const clients = getOnlineClients();

  res.json({
    amount: clients.length,
    clients,
  });
});

app.get("/rmx/server/api/v1/friends/:accountId", async (req, res) => {
  try {
    const friends = await Friends.findOne({ accountId: req.params.accountId }).lean();
    const accepted =
      friends && friends.list && Array.isArray(friends.list.accepted)
        ? friends.list.accepted
        : [];

    res.json({
      friends: accepted.map(formatFriend),
    });
  } catch (err) {
    log.error("RMX friends lookup failed:", err);
    res.json({ friends: [] });
  }
});

module.exports = app;
