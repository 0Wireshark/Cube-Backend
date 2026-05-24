const express = require("express");
const app = express.Router();
const axios = require("axios");
const net = require("net");
const sjcl = require('sjcl');
const User = require("../model/user.js");
const Friends = require("../model/friends.js");
const functions = require("../structs/functions.js");
const error = require("../structs/error.js");
const { verifyToken } = require("../tokenManager/tokenVerify.js");
const config = require("../Config/config.json");
const log = require("../structs/log.js");

global.parties = {};
var pings = [];
var vcParticipants = {};
var vcInfo = {};
var vcConnectionRequests = {};
var lastVoiceClient;
var lastVoiceClientRequest;
var vivoxTokenSerial = 0;

const DEFAULT_VIVOX_SECRET = "zcETsPpEAysznTyDXK4TEzwLQPcTvTAO";
const DEFAULT_RTCP_DEPLOYMENT_ID = "";
const DEFAULT_RTCP_CLIENT_ID = "";
const DEFAULT_RTCP_CLIENT_SECRET = "";
const DEFAULT_RTCP_TOKEN_REUSE_MS = 30000;
const DEFAULT_PARTY_CONFIG = {
  joinability: "OPEN",
  discoverability: "ALL",
  max_size: 16,
  invite_ttl_seconds: 14400,
  intention_ttl: 60,
  chat_enabled: true,
  join_confirmation: false,
  sub_type: "default",
  type: "DEFAULT"
};

function now() {
  return new Date().toISOString();
}

function firstString(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }

  return "";
}

function normalizeVoiceProvider(provider) {
  const value = firstString(provider).toLowerCase();
  if (["eos", "eosvoicechat", "rtc", "rtcp"].includes(value)) return "rtcp";
  if (value === "vivox") return "vivox";
  return value || "rtcp";
}

function normalizeClientIp(value) {
  let ip = firstString(value);

  if (ip.startsWith("[") && ip.includes("]")) {
    ip = ip.slice(1, ip.indexOf("]"));
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) {
    ip = ip.slice(0, ip.lastIndexOf(":"));
  }

  if (ip.toLowerCase().startsWith("::ffff:")) {
    ip = ip.slice(7);
  }

  return net.isIP(ip) ? ip : "127.0.0.1";
}

function getRequestIp(req) {
  const forwarded = Array.isArray(req.headers["x-forwarded-for"])
    ? req.headers["x-forwarded-for"][0]
    : req.headers["x-forwarded-for"];

  return normalizeClientIp(firstString(
    forwarded?.split(",")[0],
    req.headers["cf-connecting-ip"],
    req.ip,
    req.socket?.remoteAddress,
    "127.0.0.1"
  ));
}

function getVoiceSettings() {
  const voice = config.voice || {};
  const vivox = voice.vivox || {};
  const rtcp = voice.rtcp || {};

  return {
    enabled: voice.enabled !== false,
    provider: normalizeVoiceProvider(firstString(process.env.CUBE_VOICE_PROVIDER, voice.provider, "rtcp")),
    implementation: firstString(process.env.CUBE_VOICE_IMPLEMENTATION, voice.implementation, voice.voiceChatImplementation),
    timeoutMs: Math.max(1000, Number(process.env.CUBE_VOICE_TIMEOUT_MS || voice.timeoutMs || 6000)),
    vivox: {
      enabled: vivox.enabled !== false,
      issuer: firstString(process.env.CUBE_VIVOX_ISSUER, vivox.issuer, "epicgames"),
      domain: firstString(process.env.CUBE_VIVOX_DOMAIN, vivox.domain, "mtu1xp.vivox.com"),
      secret: firstString(process.env.CUBE_VIVOX_SECRET, vivox.secret, DEFAULT_VIVOX_SECRET),
      tokenTtlSeconds: Math.max(30, Number(process.env.CUBE_VIVOX_TOKEN_TTL_SECONDS || vivox.tokenTtlSeconds || 300))
    },
    rtcp: {
      enabled: rtcp.enabled === true || process.env.CUBE_RTCP_ENABLED === "true",
      authUrl: firstString(process.env.CUBE_RTCP_AUTH_URL, rtcp.authUrl, "https://api.epicgames.dev/auth/v1/oauth/token"),
      apiBaseUrl: firstString(process.env.CUBE_RTCP_API_BASE_URL, rtcp.apiBaseUrl, "https://api.epicgames.dev"),
      deploymentId: firstString(process.env.CUBE_RTCP_DEPLOYMENT_ID, rtcp.deploymentId, DEFAULT_RTCP_DEPLOYMENT_ID),
      clientId: firstString(process.env.CUBE_RTCP_CLIENT_ID, rtcp.clientId, DEFAULT_RTCP_CLIENT_ID),
      clientSecret: firstString(process.env.CUBE_RTCP_CLIENT_SECRET, rtcp.clientSecret, DEFAULT_RTCP_CLIENT_SECRET),
      tokenReuseMs: Math.max(1000, Number(process.env.CUBE_RTCP_TOKEN_REUSE_MS || rtcp.tokenReuseMs || DEFAULT_RTCP_TOKEN_REUSE_MS))
    }
  };
}

function getRequestedVoiceProviders(body, settings) {
  const requested = body?.providers;
  const providerNames = Array.isArray(requested)
    ? requested.map(name => String(name).toLowerCase())
    : requested && typeof requested === "object"
      ? Object.keys(requested).map(name => name.toLowerCase())
      : [];
  const hasProviderRequest = providerNames.length > 0;

  return {
    rtcp: settings.rtcp.enabled && (
      providerNames.includes("rtcp") ||
      providerNames.includes("rtc") ||
      providerNames.includes("eos") ||
      providerNames.includes("eosvoicechat") ||
      (!hasProviderRequest && settings.provider === "rtcp")
    ),
    vivox: settings.vivox.enabled && (
      providerNames.includes("vivox") ||
      (!hasProviderRequest && settings.provider === "vivox")
    )
  };
}

function getPartyVoiceImplementation(settings) {
  const implementation = firstString(settings.implementation).toLowerCase();
  if (implementation.includes("vivox")) return "Vivox";
  if (implementation.includes("eos") || implementation.includes("rtc")) return "EOS";
  return settings.provider === "rtcp" ? "EOS" : "Vivox";
}

function getAllParties() {
  return Object.values(global.parties || {});
}

function normalizePartyConfig(partyConfig) {
  return {
    ...DEFAULT_PARTY_CONFIG,
    ...(partyConfig && typeof partyConfig === "object" ? partyConfig : {})
  };
}

function normalizePartyMeta(meta) {
  const normalized = meta && typeof meta === "object" ? { ...meta } : {};
  if (!normalized["VoiceChat:implementation_s"]) {
    normalized["VoiceChat:implementation_s"] = getPartyVoiceImplementation(getVoiceSettings());
  }

  return normalized;
}

function getPartyByMember(accountId) {
  return getAllParties().find(party => party.members?.some(member => member.account_id == accountId));
}

function getMemberIndex(party, accountId) {
  return party.members.findIndex(member => member.account_id == accountId);
}

function getMember(party, accountId) {
  return party.members.find(member => member.account_id == accountId);
}

function upsertVoiceParticipant(pid, accountId, req) {
  if (!vcParticipants[pid]) vcParticipants[pid] = [];

  const participant = {
    puid: accountId,
    clientIp: getRequestIp(req),
    hardMuted: false
  };

  const existingIndex = vcParticipants[pid].findIndex(item => item.puid == accountId);
  if (existingIndex === -1) {
    vcParticipants[pid].push(participant);
  } else {
    vcParticipants[pid][existingIndex] = participant;
  }

  return participant;
}

function getVoiceParticipantCount(pid) {
  return vcParticipants[pid]?.length || 0;
}

function removeVoiceParticipant(pid, accountId) {
  delete vcConnectionRequests[`${pid}:${accountId}`];
  if (vcInfo[pid]?.tokens) delete vcInfo[pid].tokens[accountId];
  if (vcInfo[pid]?.tokenExpiresAt) delete vcInfo[pid].tokenExpiresAt[accountId];

  if (!vcParticipants[pid]) return;

  vcParticipants[pid] = vcParticipants[pid].filter(item => item.puid != accountId);

  if (vcParticipants[pid].length === 0) {
    delete vcParticipants[pid];
    delete vcInfo[pid];
  }
}

function clearVoiceRoom(pid) {
  delete vcParticipants[pid];
  delete vcInfo[pid];
  for (const key of Object.keys(vcConnectionRequests)) {
    if (key.startsWith(`${pid}:`)) delete vcConnectionRequests[key];
  }
}

function getCaptain(party) {
  return party.members.find(member => member.role === "CAPTAIN") || party.members[0] || { account_id: "" };
}

function isCaptain(party, accountId) {
  return getCaptain(party).account_id == accountId;
}

function getSquadAssignmentKey(party) {
  if (!party.meta) party.meta = {};
  if (party.meta["Default:RawSquadAssignments_j"]) return "Default:RawSquadAssignments_j";
  if (party.meta["RawSquadAssignments_j"]) return "RawSquadAssignments_j";
  return "Default:RawSquadAssignments_j";
}

function parseSquadAssignments(party, key) {
  if (!key || !party.meta[key]) return { RawSquadAssignments: [] };
  try {
    const parsed = JSON.parse(party.meta[key]);
    if (!Array.isArray(parsed.RawSquadAssignments)) parsed.RawSquadAssignments = [];
    return parsed;
  } catch {
    return { RawSquadAssignments: [] };
  }
}

function syncSquadAssignments(party) {
  const key = getSquadAssignmentKey(party);
  const assignments = parseSquadAssignments(party, key);
  if (!key || !assignments) return {};

  const previousAssignments = new Map(
    assignments.RawSquadAssignments
      .filter(entry => entry?.memberId)
      .map(entry => [entry.memberId, entry])
  );

  assignments.RawSquadAssignments = party.members.map((member, index) => ({
    ...(previousAssignments.get(member.account_id) || {}),
    memberId: member.account_id,
    absoluteMemberIdx: index
  }));

  party.meta[key] = JSON.stringify(assignments);
  return { [key]: party.meta[key] };
}

function addSquadAssignment(party) {
  return syncSquadAssignments(party);
}

function removeSquadAssignment(party) {
  return syncSquadAssignments(party);
}

function sendPartyUpdate(party, updates = {}, removed = []) {
  const captain = getCaptain(party);
  party.members.forEach(member => {
    functions.sendXmppMessageToId({
      captain_id: captain.account_id,
      created_at: party.created_at,
      invite_ttl_seconds: 14400,
      max_number_of_members: party.config?.max_size || 16,
      ns: "Fortnite",
      party_id: party.id,
      party_privacy_type: party.config?.joinability || "OPEN",
      party_state_overridden: {},
      party_state_removed: removed,
      party_state_updated: updates,
      party_sub_type: party.meta?.["urn:epic:cfg:party-type-id_s"],
      party_type: "DEFAULT",
      revision: party.revision || 0,
      sent: now(),
      type: "com.epicgames.social.party.notification.v0.PARTY_UPDATED",
      updated_at: party.updated_at || now()
    }, member.account_id);
  });
}

function sendMemberJoined(party, member, connection, memberState) {
  party.members.forEach(target => {
    functions.sendXmppMessageToId({
      account_dn: connection.meta?.["urn:epic:member:dn_s"],
      account_id: member.account_id,
      connection: {
        connected_at: now(),
        id: connection.id,
        meta: connection.meta || {},
        updated_at: now()
      },
      joined_at: member.joined_at,
      member_state_updated: memberState || {},
      ns: "Fortnite",
      party_id: party.id,
      revision: member.revision || 0,
      sent: now(),
      type: "com.epicgames.social.party.notification.v0.MEMBER_JOINED",
      updated_at: now()
    }, target.account_id);
  });
}

function sendMemberLeft(party, accountId) {
  party.members.forEach(member => {
    functions.sendXmppMessageToId({
      account_id: accountId,
      member_state_update: {},
      ns: "Fortnite",
      party_id: party.id,
      revision: party.revision || 0,
      sent: now(),
      type: "com.epicgames.social.party.notification.v0.MEMBER_LEFT"
    }, member.account_id);
  });
}

function detachAccountFromOtherParties(accountId, keepPartyId = null) {
  for (const party of [...getAllParties()]) {
    if (party.id === keepPartyId) continue;

    const memberIndex = getMemberIndex(party, accountId);
    if (memberIndex === -1) continue;

    party.members.splice(memberIndex, 1);
    party.invites = (party.invites || []).filter(invite => invite.sent_to != accountId && invite.sent_by != accountId);
    party.intentions = (party.intentions || []).filter(intention => intention.requester_id != accountId && intention.requestee_id != accountId);
    removePingsForAccount(accountId);
    removeVoiceParticipant(party.id, accountId);

    sendMemberLeft({ ...party, members: [...party.members, { account_id: accountId }] }, accountId);

    if (party.members.length === 0) {
      clearVoiceRoom(party.id);
      delete global.parties[party.id];
      continue;
    }

    if (!party.members.some(member => member.role === "CAPTAIN")) {
      party.members[0].role = "CAPTAIN";
    }

    const updates = syncSquadAssignments(party);
    party.revision = (party.revision || 0) + 1;
    party.updated_at = now();
    global.parties[party.id] = party;
    sendPartyUpdate(party, updates, []);
  }
}

function removePing(sentTo, sentBy) {
  const index = pings.findIndex(ping => ping.sent_to == sentTo && ping.sent_by == sentBy);
  if (index !== -1) pings.splice(index, 1);
}

function removePingsForAccount(accountId) {
  pings = pings.filter(ping => ping.sent_to != accountId && ping.sent_by != accountId);
}

app.get("/party/api/v1/Fortnite/user/:accountId/notifications/undelivered/count", verifyToken, async (req, res) => {
    const invites = getAllParties().flatMap(party => party.invites || []).filter(invite => invite.sent_to == req.params.accountId);
    res.json({
        "pings": pings.filter(x => x.sent_to == req.params.accountId).length,
        "invites": invites.length,
    });
});

app.get("/party/api/v1/Fortnite/user/:accountId", verifyToken, async (req, res) => {
  const current = getAllParties().filter(party => party.members.some(member => member.account_id == req.params.accountId));
  const invites = getAllParties().flatMap(party => party.invites || []).filter(invite => invite.sent_to == req.params.accountId);
  res.json({
    "current": current,
    "pending": [],
    "invites": invites,
    "pings": pings.filter(x => x.sent_to == req.params.accountId)
  });
});

app.post("/party/api/v1/Fortnite/parties", verifyToken, async (req, res) => {
  if (!req.body.join_info) return res.json({});
  if (!req.body.join_info.connection) return res.json({});

  const id = functions.MakeID().replace(/-/ig, "");
  const accountId = (req.body.join_info.connection.id || "").split("@prod")[0];
  detachAccountFromOtherParties(accountId);

  var party = {
    "id": id,
    "created_at": now(),
    "updated_at": now(),
    "config": normalizePartyConfig(req.body.config),
    "members": [{
      "account_id": accountId,
      "meta": req.body.join_info.meta || {},
      "connections": [
        {
          "id": req.body.join_info.connection.id || "",
          "connected_at": now(),
          "updated_at": now(),
          "yield_leadership": req.body.join_info.connection.yield_leadership || false,
          "meta": req.body.join_info.connection.meta || {}
        }
      ],
      "revision": 0,
      "updated_at": now(),
      "joined_at": now(),
      "role": "CAPTAIN"
    }],
    "applicants": [],
    "meta": normalizePartyMeta(req.body.meta),
    "invites": [],
    "revision": 0,
    "intentions": []
  };
  syncSquadAssignments(party);
  global.parties[id] = party;
  res.json(party);
})

app.patch("/party/api/v1/Fortnite/parties/:pid", verifyToken, async (req, res) => {
  var newp = global.parties[req.params.pid];
  if (!newp) return error.createError("errors.com.epicgames.party.not_found", `Party ${req.params.pid} does not exist!`, undefined, 51002, undefined, 404, res);

  let editingMember = newp.members.find(m => m.account_id == req.user.accountId);
  if (editingMember && editingMember.role != "CAPTAIN") return error.createError("errors.com.epicgames.party.unauthorized", `User ${req.user.accountId} is not allowed to edit party ${req.params.pid}!`, undefined, 51015, undefined, 403, res);

  if (req.body.config) {
    for (var prop of Object.keys(req.body.config)) {
      newp.config[prop] = req.body.config[prop];
    }
  }

  const metaDelete = Array.isArray(req.body.meta?.delete) ? req.body.meta.delete : [];
  const metaUpdate = req.body.meta?.update && typeof req.body.meta.update === "object" ? req.body.meta.update : {};
  if (req.body.meta) {
    for (var prop of metaDelete) {
      delete newp.meta[prop];
    }

    for (var prop of Object.keys(metaUpdate)) {
      newp.meta[prop] = metaUpdate[prop];
    }
  }

  newp.revision = Number.isInteger(req.body.revision) ? req.body.revision : (newp.revision || 0) + 1;

  const captain = newp.members.find((member) => member.role === "CAPTAIN");

  newp.updated_at = now();
  global.parties[req.params.pid] = newp;

  res.status(204).send();
  sendPartyUpdate(newp, metaUpdate, metaDelete);
});

app.patch("/party/api/v1/Fortnite/parties/:pid/members/:accountId/meta", verifyToken, async (req, res) => {
  var newp = global.parties[req.params.pid];
  if (!newp) return error.createError("errors.com.epicgames.party.not_found", `Party ${req.params.pid} does not exist!`, undefined, 51002, undefined, 404, res);
  var mIndex;
  for (var member of newp.members) {
    if (member.account_id == req.params.accountId) {
      mIndex = newp.members.indexOf(member);
      break;
    }
  }
  var member = newp.members[mIndex];
  if (!member) return res.status(404).end();
  if (req.user.accountId != req.params.accountId) return error.createError("errors.com.epicgames.party.unauthorized", `User ${req.user.accountId} is not allowed to edit member ${req.params.accountId}!`, undefined, 51015, undefined, 403, res);

  const metaDelete = Array.isArray(req.body.delete) ? req.body.delete : [];
  const metaUpdate = req.body.update && typeof req.body.update === "object" ? req.body.update : {};
  for (var prop of metaDelete) {
    delete member.meta[prop];
  }

  for (var prop of Object.keys(metaUpdate)) {
    member.meta[prop] = metaUpdate[prop];
  }

  member.revision = Number.isInteger(req.body.revision) ? req.body.revision : (member.revision || 0) + 1;

  member.updated_at = now();
  newp.members[mIndex] = member;
  newp.updated_at = now();
  global.parties[req.params.pid] = newp;

  res.status(204).send();
  newp.members.forEach(async (member2) => {
    functions.sendXmppMessageToId({
        "account_id": req.params.accountId,
        "account_dn": member.meta["urn:epic:member:dn_s"],
        "member_state_updated": metaUpdate,
        "member_state_removed": metaDelete,
        "member_state_overridden": {},
        "party_id": newp.id,
        "updated_at": now(),
        "sent": now(),
        "revision": member.revision,
        "ns": "Fortnite",
        "type": "com.epicgames.social.party.notification.v0.MEMBER_STATE_UPDATED",
    }, member2.account_id);
  });
});

app.get("/party/api/v1/Fortnite/parties/:pid", verifyToken, async (req, res) => {
  var newp = global.parties[req.params.pid];
  if (!newp) return error.createError("errors.com.epicgames.party.not_found", `Party ${req.params.pid} does not exist!`, undefined, 51002, undefined, 404, res);
  res.json(newp);
});

app.delete("/party/api/v1/Fortnite/parties/:pid/members/:accountId", verifyToken, async (req, res) => {
  var newp = global.parties[req.params.pid];
  if (!newp) return error.createError("errors.com.epicgames.party.not_found", `Party ${req.params.pid} does not exist!`, undefined, 51002, undefined, 404, res);
  const mIndex = getMemberIndex(newp, req.params.accountId);
  if (mIndex === -1) return res.status(404).end();
  if (req.user.accountId != req.params.accountId && !isCaptain(newp, req.user.accountId)) return error.createError("errors.com.epicgames.party.unauthorized", `User ${req.user.accountId} is not allowed to delete member ${req.params.accountId}!`, undefined, 51015, undefined, 403, res);

  const removedAccountId = req.params.accountId;
  newp.members.splice(mIndex, 1);
  newp.invites = (newp.invites || []).filter(invite => invite.sent_to != removedAccountId && invite.sent_by != removedAccountId);
  newp.intentions = (newp.intentions || []).filter(intention => intention.requester_id != removedAccountId && intention.requestee_id != removedAccountId);
  removePing(removedAccountId, req.user.accountId);
  removePing(req.user.accountId, removedAccountId);
  removeVoiceParticipant(req.params.pid, removedAccountId);
  res.status(204).end();

  sendMemberLeft({ ...newp, members: [...newp.members, { account_id: removedAccountId }] }, removedAccountId);
  if (newp.members.length == 0) {
    clearVoiceRoom(req.params.pid);
    delete global.parties[req.params.pid];
  } else {
    if (!newp.members.some(member => member.role === "CAPTAIN")) {
      newp.members[0].role = "CAPTAIN";
    }
    const updates = removeSquadAssignment(newp);
    newp.revision = (newp.revision || 0) + 1;
    newp.updated_at = now();
    global.parties[req.params.pid] = newp;
    sendPartyUpdate(newp, updates, []);
  }
});

app.post("/party/api/v1/Fortnite/parties/:pid/members/:accountId/join", verifyToken, async (req, res) => {
  var newp = global.parties[req.params.pid];
  if (!newp) return error.createError("errors.com.epicgames.party.not_found", `Party ${req.params.pid} does not exist!`, undefined, 51002, undefined, 404, res);
  if (req.user.accountId != req.params.accountId) return error.createError("errors.com.epicgames.party.unauthorized", `User ${req.user.accountId} is not allowed to join as ${req.params.accountId}!`, undefined, 51015, undefined, 403, res);
  if (!req.body.connection) return res.status(400).end();

  if (getMemberIndex(newp, req.params.accountId) !== -1) {
    detachAccountFromOtherParties(req.params.accountId, newp.id);
    return res.json({
      status: "JOINED",
      party_id: newp.id,
    });
  }
  if (newp.members.length >= (newp.config?.max_size || 16)) return error.createError("errors.com.epicgames.party.party_full", `Party ${req.params.pid} is full!`, undefined, 51013, undefined, 403, res);

  const accountId = (req.body.connection.id || "").split("@prod")[0] || req.params.accountId;
  if (accountId != req.params.accountId) return res.status(400).end();
  detachAccountFromOtherParties(accountId, newp.id);

  if (req.body.connection.yield_leadership) {
    newp.members.forEach(member => member.role = "MEMBER");
  }

  var mem = {
    "account_id": accountId,
    "meta": req.body.meta || {},
    "connections": [
      {
        "id": req.body.connection.id || "",
        "connected_at": now(),
        "updated_at": now(),
        "yield_leadership": req.body.connection.yield_leadership ? true : false,
        "meta": req.body.connection.meta || {}
      }
    ],
    "revision": 0,
    "updated_at": now(),
    "joined_at": now(),
    "role": req.body.connection.yield_leadership ? "CAPTAIN" : "MEMBER"
  };
  newp.members.push(mem);
  const updates = addSquadAssignment(newp);
  newp.revision = (newp.revision || 0) + 1;
  newp.updated_at = now();
  newp.invites = (newp.invites || []).filter(invite => invite.sent_to != accountId);
  newp.intentions = (newp.intentions || []).filter(intention => intention.requester_id != accountId && intention.requestee_id != accountId);
  removePingsForAccount(accountId);
  global.parties[req.params.pid] = newp;

  res.json({
    status: "JOINED",
    party_id: newp.id,
  });
  sendMemberJoined(newp, mem, req.body.connection, req.body.meta || {});
  sendPartyUpdate(newp, updates, []);
});

app.post("/party/api/v1/Fortnite/parties/:pid/members/:accountId/promote", verifyToken, async (req, res) => {
  var newp = global.parties[req.params.pid];
  if (!newp) return error.createError("errors.com.epicgames.party.not_found", `Party ${req.params.pid} does not exist!`, undefined, 51002, undefined, 404, res);
  const captain = newp.members.findIndex((member) => member.role === "CAPTAIN");
  if (captain === -1) return res.status(404).end();
  if (newp.members[captain].account_id != req.user.accountId) return error.createError("errors.com.epicgames.party.unauthorized", `User ${req.user.accountId} is not allowed to promote member ${req.params.accountId}!`, undefined, 51015, undefined, 403, res);
  const newCaptain = newp.members.findIndex((member) => member.account_id === req.params.accountId);
  if (newCaptain === -1) return res.status(404).end();
  if (captain != -1) {
    newp.members[captain].role = "MEMBER";
  }
  if (newCaptain != -1) {
      newp.members[newCaptain].role = "CAPTAIN";
  }

  newp.revision = (newp.revision || 0) + 1;
  newp.updated_at = now();
  global.parties[req.params.pid] = newp;

  res.status(204).end();
  newp.members.forEach(async (member) => {
    functions.sendXmppMessageToId({
        account_id: req.params.accountId,
        member_state_update: {},
        ns: "Fortnite",
        party_id: newp.id,
        revision: newp.revision || 0,
        sent: new Date().toISOString(),
        type: "com.epicgames.social.party.notification.v0.MEMBER_NEW_CAPTAIN"
    }, member.account_id);
  });
});

app.post("/party/api/v1/Fortnite/user/:accountId/pings/:pingerId", verifyToken, async (req, res) => {
  var memory = functions.GetVersionInfo(req);
  removePing(req.params.accountId, req.params.pingerId);

  var d = new Date();
  d.setHours(d.getHours() + 1);
  var ping = {
    sent_by: req.params.pingerId,
    sent_to: req.params.accountId,
    sent_at: new Date().toISOString(),
    expires_at: d.toISOString(),
    meta: req.body.meta
  };
  pings.push(ping);
  res.json(ping);
  const pinger = await User.findOne({ accountId: req.params.pingerId }).lean();
  functions.sendXmppMessageToId({
    expires: ping.expires_at,
    meta: req.body.meta,
    ns: "Fortnite",
    pinger_dn: pinger?.username || "",
    pinger_id: req.params.pingerId,
    sent: ping.sent_at,
    version: memory.build.toString().padEnd(5, 0),
    type: "com.epicgames.social.party.notification.v0.PING"
  }, req.params.accountId);
});

app.delete("/party/api/v1/Fortnite/user/:accountId/pings/:pingerId", verifyToken, async (req, res) => {
  removePing(req.params.accountId, req.params.pingerId);
  res.status(204).end();
});

app.get("/party/api/v1/Fortnite/user/:accountId/pings/:pingerId/parties", verifyToken, async (req, res) => {
  var query = pings.filter(p => p.sent_to == req.params.accountId && p.sent_by == req.params.pingerId);
  if (query.length == 0) query = [{
    sent_by: req.params.pingerId
  }];

  res.json(query.map(y => {
    var party = Object.values(global.parties).find(x => x.members.findIndex(m => m.account_id == y.sent_by) != -1);
    if (!party) return null;
    return {
      id: party.id,
      created_at: party.created_at,
      updated_at: party.updated_at,
      config: party.config,
      members: party.members,
      applicants: [],
      meta: party.meta,
      invites: [],
      revision: party.revision || 0
    };
  }).filter(x => x != null));
});

app.post("/party/api/v1/Fortnite/user/:accountId/pings/:pingerId/join", verifyToken, async (req, res) => {
  var query = pings.filter(p => p.sent_to == req.params.accountId && p.sent_by == req.params.pingerId);
  if (query.length == 0) query = [{
    sent_by: req.params.pingerId
  }];
  var newp = getPartyByMember(query[0].sent_by);
  if (!newp) return error.createError("errors.com.epicgames.party.not_found", `Party does not exist!`, undefined, 51002, undefined, 404, res);
  if (req.user.accountId != req.params.accountId) return error.createError("errors.com.epicgames.party.unauthorized", `User ${req.user.accountId} is not allowed to join as ${req.params.accountId}!`, undefined, 51015, undefined, 403, res);
  if (!req.body.connection) return res.status(400).end();

  if (getMemberIndex(newp, req.params.accountId) !== -1) {
    detachAccountFromOtherParties(req.params.accountId, newp.id);
    return res.json({
      status: "JOINED",
      party_id: newp.id,
    });
  }
  if (newp.members.length >= (newp.config?.max_size || 16)) return error.createError("errors.com.epicgames.party.party_full", `Party ${newp.id} is full!`, undefined, 51013, undefined, 403, res);

  const accountId = (req.body.connection.id || "").split("@prod")[0] || req.params.accountId;
  if (accountId != req.params.accountId) return res.status(400).end();
  detachAccountFromOtherParties(accountId, newp.id);

  if (req.body.connection.yield_leadership) {
    newp.members.forEach(member => member.role = "MEMBER");
  }

  var mem = {
    "account_id": accountId,
    "meta": req.body.meta || {},
    "connections": [
      {
        "id": req.body.connection.id || "",
        "connected_at": now(),
        "updated_at": now(),
        "yield_leadership": req.body.connection.yield_leadership ? true : false,
        "meta": req.body.connection.meta || {}
      }
    ],
    "revision": 0,
    "updated_at": now(),
    "joined_at": now(),
    "role": req.body.connection.yield_leadership ? "CAPTAIN" : "MEMBER"
  };
  newp.members.push(mem);
  const updates = addSquadAssignment(newp);
  newp.revision = (newp.revision || 0) + 1;
  newp.updated_at = now();
  newp.invites = (newp.invites || []).filter(invite => invite.sent_to != accountId);
  newp.intentions = (newp.intentions || []).filter(intention => intention.requester_id != accountId && intention.requestee_id != accountId);
  removePingsForAccount(accountId);
  global.parties[newp.id] = newp;

  res.json({
    status: "JOINED",
    party_id: newp.id,
  });
  sendMemberJoined(newp, mem, req.body.connection, req.body.meta || {});
  sendPartyUpdate(newp, updates, []);
});

app.post('/party/api/v1/Fortnite/parties/:pid/invites/:accountId', verifyToken, async (req, res) => {
  var memory = functions.GetVersionInfo(req);
  var newp = global.parties[req.params.pid];
  if (!newp) return error.createError("errors.com.epicgames.party.not_found", `Party ${req.params.pid} does not exist!`, undefined, 51002, undefined, 404, res);
  const inviter = newp.members.find(x => x.account_id == req.user.accountId);
  if (!inviter) return error.createError("errors.com.epicgames.party.unauthorized", `User ${req.user.accountId} is not a member of party ${req.params.pid}!`, undefined, 51015, undefined, 403, res);
  var pIndex;
  if ((pIndex = newp.invites.findIndex(p => p.sent_to == req.params.accountId && p.sent_by == req.user.accountId)) != -1)
    newp.invites.splice(pIndex, 1);

  var d = new Date();
  d.setHours(d.getHours() + 1);
  var invite = {
    party_id: newp.id,
    sent_by: req.user.accountId,
    meta: req.body,
    sent_to: req.params.accountId,
    sent_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    expires_at: d.toISOString(),
    status: 'SENT'
  };

  newp.invites.push(invite);
  newp.updated_at = now();
  global.parties[req.params.pid] = newp;

  var friends = await Friends.findOne({ accountId: req.user.accountId }).lean();
  if (!friends) friends = { list: { accepted: [] } };

  res.status(204).end();
  functions.sendXmppMessageToId({
    expires: invite.expires_at,
    meta: req.body,
    ns: "Fortnite",
    party_id: newp.id,
    inviter_dn: inviter.meta['urn:epic:member:dn_s'],
    inviter_id: req.user.accountId,
    invitee_id: req.params.accountId,
    members_count: newp.members.length,
    sent_at: invite.sent_at,
    updated_at: invite.updated_at,
    friends_ids: newp.members.filter(m => friends.list.accepted.find(f => f.accountId == m.account_id)).map(m => m.account_id),
    sent: new Date().toISOString(),
    type: "com.epicgames.social.party.notification.v0.INITIAL_INVITE"
  }, req.params.accountId);
  if (req.query.sendPing == "true") {
    removePing(req.params.accountId, req.user.accountId);

    var d = new Date();
    d.setHours(d.getHours() + 1);
    var ping = {
      sent_by: req.user.accountId,
      sent_to: req.params.accountId,
      sent_at: new Date().toISOString(),
      expires_at: d.toISOString(),
      meta: req.body
    };
    pings.push(ping);

    functions.sendXmppMessageToId({
          expires: invite.expires_at,
          meta: req.body.meta,
          ns: "Fortnite",
          pinger_dn: inviter.meta['urn:epic:member:dn_s'],
          pinger_id: req.user.accountId,
          sent: invite.sent_at,
          version: memory.build.toString().padEnd(5, 0),
          type: "com.epicgames.social.party.notification.v0.PING"
    }, req.params.accountId);
  }
});


app.post([
  '/party/api/v1/Fortnite/parties/:pid/invites/:accountId/decline',
  '/party/api/v1/Fortnite/parties/:pid/invites/:accountId/*/decline'
  ], verifyToken, async (req, res) => {
  var newp = global.parties[req.params.pid];
  if (!newp) return error.createError("errors.com.epicgames.party.not_found", `Party ${req.params.pid} does not exist!`, undefined, 51002, undefined, 404, res);

  if (req.user.accountId != req.params.accountId) return error.createError("errors.com.epicgames.party.unauthorized", `User ${req.user.accountId} is not allowed to decline invite for ${req.params.accountId}!`, undefined, 51015, undefined, 403, res);
  var inviteIndex = newp.invites.findIndex(p => p.sent_to == req.params.accountId);
  var invite = inviteIndex === -1 ? null : newp.invites[inviteIndex];
  if (!invite) return error.createError("errors.com.epicgames.party.not_found", `Invite ${req.params.pid} does not exist!`, undefined, 51002, undefined, 404, res);
  const inviter = newp.members.find(x => x.account_id == invite.sent_by);
  newp.invites.splice(inviteIndex, 1);
  newp.updated_at = now();
  global.parties[req.params.pid] = newp;

  res.status(204).end();

  if (inviter) functions.sendXmppMessageToId({
    expires: invite.expires_at,
    meta: req.body,
    ns: "Fortnite",
    party_id: newp.id,
    inviter_dn: inviter.meta['urn:epic:member:dn_s'],
    inviter_id: invite.sent_by,
    invitee_id: req.params.accountId,
    sent_at: invite.sent_at,
    updated_at: invite.updated_at,
    sent: new Date().toISOString(),
    type: "com.epicgames.social.party.notification.v0.INVITE_CANCELLED"
  }, invite.sent_by);
});

app.post("/party/api/v1/Fortnite/members/:accountId/intentions/:senderId", verifyToken, async (req, res) => {
  var party = Object.values(global.parties).find(x => x.members.findIndex(m => m.account_id == req.params.senderId) != -1);
  if (!party) return error.createError("errors.com.epicgames.party.not_found", `Party does not exist!`, undefined, 51002, undefined, 404, res);
  const sender = party.members.find(x => x.account_id == req.params.senderId);
  const captain = party.members.find((member) => member.role === "CAPTAIN");
  if (!sender || !captain) return error.createError("errors.com.epicgames.party.not_found", `Party member does not exist!`, undefined, 51002, undefined, 404, res);
  var friends = await Friends.findOne({ accountId: req.params.accountId }).lean();
  if (!friends) friends = { list: { accepted: [] } };

  var d = new Date();
  d.setHours(d.getHours() + 1);
  var intention = {
		"requester_id": req.params.senderId,
		"requester_dn": sender.meta['urn:epic:member:dn_s'],
		"requester_pl": captain.account_id,
		"requester_pl_dn": captain.meta['urn:epic:member:dn_s'],
		"requestee_id": req.params.accountId,
		"meta": req.body,
    "expires_at": d.toISOString(),
		"sent_at": now(),
	};

  party.intentions.push(intention);
  res.json(intention);

  functions.sendXmppMessageToId({
    expires_at: intention.expires_at,
    requester_id: req.params.senderId,
    requester_dn: sender.meta['urn:epic:member:dn_s'],
    requester_pl: captain.account_id,
    requester_pl_dn: captain.meta['urn:epic:member:dn_s'],
    requestee_id: req.params.accountId,
    meta: req.body,
    sent_at: now(),
    updated_at: now(),
    friends_ids: party.members.filter(m => friends.list.accepted.find(f => f.accountId == m.account_id)).map(m => m.account_id),
    members_count: party.members.length,
    party_id: party.id,
    ns: "Fortnite",
    sent: now(),
    type: "com.epicgames.social.party.notification.v0.INITIAL_INTENTION"
  }, req.params.accountId);
});

function vxGenerateToken(key, payload) {
    const base64urlHeader = base64URLEncode("{}");

    const base64urlPayload = base64URLEncode(JSON.stringify(payload));

    const segments = [base64urlHeader, base64urlPayload];
    const toSign = segments.join(".");

    const hmac = new sjcl.misc.hmac(sjcl.codec.utf8String.toBits(key), sjcl.hash.sha256);
    const signature = sjcl.codec.base64.fromBits(hmac.encrypt(toSign));
    const base64urlSigned = signature.replace(/\+/g, "-").replace(/\//g, "_").replace(/\=+$/, "");

    segments.push(base64urlSigned);

    return segments.join(".");
}


function base64URLEncode(value) {
    return Buffer.from(value).toString('base64').replace(/\+/g, "-").replace(/\//g, "_").replace(/\=+$/, "");
}

function getNextVivoxTokenSerial() {
  vivoxTokenSerial = (vivoxTokenSerial + 1) % 1000000;
  return Date.now() * 1000 + vivoxTokenSerial;
}

function toProperCase(value) {
  const text = String(value || "");
  return text ? text[0].toUpperCase() + text.slice(1).toLowerCase() : "";
}

function getRtcpRoomUrl(settings, pid) {
  const baseUrl = settings.rtcp.apiBaseUrl.replace(/\/+$/, "");
  const rtcBaseUrl = baseUrl.endsWith("/rtc") ? baseUrl : `${baseUrl}/rtc`;

  return `${rtcBaseUrl}/v1/${encodeURIComponent(settings.rtcp.deploymentId)}/room/${encodeURIComponent(pid)}`;
}

function getAxiosErrorMessage(err) {
  const response = err?.response;
  if (!response) return err?.message || "unknown error";

  const data = response.data || {};
  const detail = typeof data === "string"
    ? data.slice(0, 300)
    : data.errorCode || data.error || data.errorMessage || data.error_description || data.message;

  return [
    `status=${response.status}`,
    detail || err.message
  ].filter(Boolean).join(" ");
}

function buildRtcpConnectionInfo(pid, accountId) {
  const room = vcInfo[pid];
  const token = room?.tokens?.[accountId];
  const expiresAt = room?.tokenExpiresAt?.[accountId] || 0;

  if (!token || !room?.url || !room?.name || expiresAt <= Date.now()) return null;

  return {
    participant_token: token,
    client_base_url: room.url,
    room_name: room.name
  };
}

function storeRtcpConnectionInfo(pid, accountId, joinToken, token, settings) {
  if (!vcInfo[pid]) {
    vcInfo[pid] = {
      name: joinToken.roomId,
      url: joinToken.clientBaseUrl,
      tokens: {},
      tokenExpiresAt: {}
    };
  }

  vcInfo[pid].name = joinToken.roomId || vcInfo[pid].name;
  vcInfo[pid].url = joinToken.clientBaseUrl || vcInfo[pid].url;
  vcInfo[pid].tokens[accountId] = token;
  vcInfo[pid].tokenExpiresAt[accountId] = Date.now() + settings.rtcp.tokenReuseMs;

  return buildRtcpConnectionInfo(pid, accountId);
}

function isVoiceClientExpired(client) {
  if (!client?.access_token) return true;
  const expiresAt = new Date(client.expires_at || 0).getTime();
  return !expiresAt || expiresAt - 30000 <= Date.now();
}

async function getRtcpClient(settings) {
  if (!settings.rtcp.enabled) return null;
  const missing = [];
  if (!settings.rtcp.deploymentId) missing.push("deploymentId");
  if (!settings.rtcp.clientId) missing.push("clientId");
  if (!settings.rtcp.clientSecret) missing.push("clientSecret");
  if (missing.length) {
    log.error(`RTCP voice provider is enabled but missing: ${missing.join(", ")}`);
    return null;
  }
  if (!isVoiceClientExpired(lastVoiceClient)) return lastVoiceClient;
  if (lastVoiceClientRequest) return lastVoiceClientRequest;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    deployment_id: settings.rtcp.deploymentId
  }).toString();

  lastVoiceClientRequest = axios.post(settings.rtcp.authUrl, body, {
    timeout: settings.timeoutMs,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    auth: {
      username: settings.rtcp.clientId,
      password: settings.rtcp.clientSecret
    }
  }).then(response => {
    const data = response.data || {};
    if (!data.expires_at && data.expires_in) {
      data.expires_at = new Date(Date.now() + (Number(data.expires_in) - 60) * 1000).toISOString();
    }

    lastVoiceClient = data;
    return lastVoiceClient;
  }).finally(() => {
    lastVoiceClientRequest = null;
  });

  return lastVoiceClientRequest;
}

async function buildRtcpProvider(pid, accountId, req, settings) {
  const cached = buildRtcpConnectionInfo(pid, accountId);
  if (cached) return cached;

  const requestKey = `${pid}:${accountId}`;
  if (vcConnectionRequests[requestKey]) return vcConnectionRequests[requestKey];

  vcConnectionRequests[requestKey] = requestRtcpProvider(pid, accountId, req, settings).finally(() => {
    delete vcConnectionRequests[requestKey];
  });

  return vcConnectionRequests[requestKey];
}

async function requestRtcpProvider(pid, accountId, req, settings) {
  const client = await getRtcpClient(settings);
  if (!client) return null;

  const participant = upsertVoiceParticipant(pid, accountId, req);
  log.debug(`Requesting RTCP room token for party ${pid}, account ${accountId}, party participants: ${getVoiceParticipantCount(pid)}`);

  const response = await axios.post(
    getRtcpRoomUrl(settings, pid),
    { participants: [participant] },
    {
      timeout: settings.timeoutMs,
      headers: {
        Authorization: `${toProperCase(client.token_type)} ${client.access_token}`,
        Accept: "application/json"
      }
    }
  );

  const joinToken = response.data || {};
  const token = (joinToken.participants || []).find(item => item?.puid == accountId)?.token;

  if (!token || !joinToken.clientBaseUrl || !joinToken.roomId) {
    log.error(`RTCP voice provider returned an incomplete room token for party ${pid}.`);
    return null;
  }

  return storeRtcpConnectionInfo(pid, accountId, joinToken, token, settings);
}

function buildVivoxProvider(pid, accountId, settings) {
  if (!settings.vivox.enabled || !settings.vivox.secret) return null;

  const channel_uri = `sip:confctl-g-${settings.vivox.issuer}.p-${pid}@${settings.vivox.domain}`;
  const user_uri = `sip:.${settings.vivox.issuer}.${accountId}.@${settings.vivox.domain}`;

  const vivoxClaims = {
    vxi: getNextVivoxTokenSerial(),
    f: user_uri,
    iss: settings.vivox.issuer,
    vxa: "join",
    t: channel_uri,
    exp: Math.floor(Date.now() / 1000) + settings.vivox.tokenTtlSeconds
  };

  return {
    authorization_token: vxGenerateToken(settings.vivox.secret, vivoxClaims),
    channel_uri,
    user_uri
  };
}

app.post([
  "/party/api/v1/Fortnite/parties/:pid/members/:accountId/conferences/connection",
  "/party/api/v1/Fortnite/parties/:pid/members/:accountId/conferences/:conferenceId/connection"
], verifyToken, async (req, res) => {
  const { pid, accountId } = req.params;
  const party = global.parties[pid];
  log.debug(`POST /party/api/v1/Fortnite/parties/${pid}/members/${accountId}/conferences/connection called`);

  if (req.user.accountId != accountId) {
    return error.createError("errors.com.epicgames.party.unauthorized", `User ${req.user.accountId} is not allowed to create a voice connection for ${accountId}!`, undefined, 51015, undefined, 403, res);
  }

  if (!party || !getMember(party, accountId)) {
    return error.createError("errors.com.epicgames.party.not_found", `Party ${pid} does not exist!`, undefined, 51002, undefined, 404, res);
  }

  const settings = getVoiceSettings();
  if (!settings.enabled) {
    return error.createError("errors.com.epicgames.voice.disabled", "Voice chat is disabled.", [], 12001, undefined, 403, res);
  }

  const requested = getRequestedVoiceProviders(req.body, settings);
  const providers = {};

  if (requested.rtcp) {
    try {
      const rtcp = await buildRtcpProvider(pid, accountId, req, settings);
      if (rtcp) providers.rtcp = rtcp;
    } catch (err) {
      removeVoiceParticipant(pid, accountId);
      log.error(`RTCP voice connection failed for party ${pid}: ${getAxiosErrorMessage(err)}`);
    }
  }

  if (requested.vivox) {
    const vivox = buildVivoxProvider(pid, accountId, settings);
    if (vivox) providers.vivox = vivox;
  }

  if (!providers.rtcp && !providers.vivox) {
    return error.createError("errors.com.epicgames.voice.unavailable", "Voice chat provider is unavailable.", [], 12002, undefined, 503, res);
  }

  log.debug(`Voice connection ready for party ${pid}, account ${accountId}, providers: ${Object.keys(providers).join(",")}`);
  return res.json({ providers });
});

module.exports = app;
