const express = require("express");
const app = express.Router();
const config = require("../Config/config.json");
const functions = require("../structs/functions.js");
const log = require("../structs/log.js");
const MMCode = require("../model/mmcodes.js");
const { verifyToken } = require("../tokenManager/tokenVerify.js");
const qs = require("qs");
const error = require("../structs/error.js");
const gsAuth = require("../structs/gsAuth.js");
const crypto = require("crypto");

let buildUniqueId = {};

function parseServerEntry(serverEntry, forcedPlaylist) {
    if (typeof serverEntry !== "string") return null;

    const parts = serverEntry.split(":").map(part => part.trim());
    if (parts.length < 2) return null;
    const port = Number(parts[1]) || 7777;
    const beaconPort = Number(parts[3]) || port;
    if (!parts[0] || port < 1 || port > 65535 || beaconPort < 1 || beaconPort > 65535) return null;

    return {
        ip: parts[0],
        port,
        playlist: forcedPlaylist || parts[2] || "playlist_defaultsolo",
        beaconPort
    };
}

function findServersForPlaylist(playlist) {
    const gameServers = Array.isArray(config.gameServerIP) ? config.gameServerIP : [];
    const parsedServers = gameServers.map(server => parseServerEntry(server)).filter(Boolean);
    const playlistServers = parsedServers.filter(server => {
        return String(server.playlist).toLowerCase() === String(playlist).toLowerCase();
    });

    if (playlistServers.length > 0) return playlistServers;
    if (parsedServers[0]) return [{ ...parsedServers[0], playlist }];
    return [];
}

function findServerForPlaylist(playlist) {
    return findServersForPlaylist(playlist)[0] || null;
}

function base64UrlEncode(value) {
    return Buffer.from(value, "utf8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function getMatchmakerPayloadSecret() {
    return String(config.matchmakerPayloadSecret || config.gsAuth?.secret || "");
}

function signMatchmakerPayload(encodedPayload) {
    const secret = getMatchmakerPayloadSecret();
    if (!secret) return "";

    return crypto
        .createHmac("sha256", secret)
        .update(encodedPayload, "utf8")
        .digest("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function buildMatchmakerPayload(ticketId, route) {
    const encodedPayload = base64UrlEncode(JSON.stringify({
        ticketId,
        accountId: route.accountId,
        playlist: route.playlist,
        server: route.server,
        servers: route.servers
    }));
    const signature = signMatchmakerPayload(encodedPayload);

    return signature ? `v1.${encodedPayload}.${signature}` : `v1.${encodedPayload}`;
}

app.get("/fortnite/api/matchmaking/session/findPlayer/*", (req, res) => {
    log.debug("GET /fortnite/api/matchmaking/session/findPlayer/* called");
    res.status(200);
    res.end();
});

app.get("/fortnite/api/game/v2/matchmakingservice/ticket/player/*", verifyToken, async (req, res) => {
    log.debug("GET /fortnite/api/game/v2/matchmakingservice/ticket/player/* called");
    if (req.user.isServer == true) return res.status(403).end();
    if (req.user.matchmakingId == null) return res.status(400).end();

    const playerCustomKey = qs.parse(req.url.split("?")[1], { ignoreQueryPrefix: true })['player.option.customKey'];
    const bucketId = qs.parse(req.url.split("?")[1], { ignoreQueryPrefix: true })['bucketId'];
    if (typeof bucketId !== "string" || bucketId.split(":").length !== 4) {
        return res.status(400).end();
    }
    const rawPlaylist = bucketId.split(":")[3];
    let playlist = functions.PlaylistNames(rawPlaylist).toLowerCase();
    const customKey = typeof playerCustomKey === "string" ? playerCustomKey.trim() : "";

    let candidateServers = findServersForPlaylist(playlist);
    const selectedServer = candidateServers[0];
    if (!selectedServer) {
        log.debug("No server found for playlist", playlist);
        return error.createError("errors.com.epicgames.common.matchmaking.playlist.not_found", `No server found for playlist ${playlist}`, [], 1013, "invalid_playlist", 404, res);
    }

    let assignedServer = selectedServer;
    await global.kv.set(`playerPlaylist:${req.user.accountId}`, playlist);
    global.matchmakingTickets = global.matchmakingTickets || new Map();
    global.matchmakingPlayerServers = global.matchmakingPlayerServers || new Map();

    if (customKey) {
        let codeDocument = await MMCode.findOne({ code_lower: customKey.toLowerCase() });
        if (!codeDocument) {
            return error.createError("errors.com.epicgames.common.matchmaking.code.not_found", `The matchmaking code "${customKey}" was not found`, [], 1013, "invalid_code", 404, res);
        }
        assignedServer = {
            ip: codeDocument.ip,
            port: Number(codeDocument.port) || 7777,
            playlist: playlist,
            beaconPort: Number(codeDocument.beaconPort) || Number(codeDocument.port) || 7777
        };
        candidateServers = [assignedServer];
        const kvDocument = JSON.stringify(assignedServer);
        await global.kv.set(`playerCustomKey:${req.user.accountId}`, kvDocument);
    } else {
        await global.kv.delete(`playerCustomKey:${req.user.accountId}`);
    }
    const matchmakerRoute = {
        accountId: req.user.accountId,
        playlist,
        server: assignedServer,
        servers: candidateServers
    };
    const matchmakerPayload = buildMatchmakerPayload(req.user.matchmakingId, matchmakerRoute);
    global.matchmakingTickets.set(req.user.matchmakingId, matchmakerRoute);
    global.matchmakingTickets.set(matchmakerPayload, matchmakerRoute);
    global.matchmakingPlayerServers.set(req.user.accountId, assignedServer);

    if (typeof req.query.bucketId !== "string" || req.query.bucketId.split(":").length !== 4) {
        return res.status(400).end();
    }

    buildUniqueId[req.user.accountId] = req.query.bucketId.split(":")[0];

    if (config.gsAuth && config.gsAuth.enable === true) {
        const reservation = gsAuth.createJoinReservation({
            accountId: req.user.accountId,
            playlist,
            server: assignedServer,
            source: "matchmaking-ticket"
        });
        if (reservation) {
            log.debug(`[GSAuth] Reserved join accountId=${req.user.accountId} playlist=${reservation.playlist} ttlSeconds=${global.gsJoinTtlSeconds}`);
        }
    }

    const matchmakerIP = String(config.matchmakerIP || "");
    return res.json({
        "serviceUrl": matchmakerIP.startsWith("ws://") || matchmakerIP.startsWith("wss://") ? matchmakerIP : `ws://${matchmakerIP}`,
        "ticketType": "mms-player",
        "payload": matchmakerPayload,
        "signature": "account"
    });
});

app.get("/fortnite/api/game/v2/matchmaking/account/:accountId/session/:sessionId", (req, res) => {
    log.debug(`GET /fortnite/api/game/v2/matchmaking/account/${req.params.accountId}/session/${req.params.sessionId} called`);
    res.json({
        "accountId": req.params.accountId,
        "sessionId": req.params.sessionId,
        "key": "none"
    });
});

app.get("/fortnite/api/matchmaking/session/:sessionId", verifyToken, async (req, res) => {
    log.debug(`GET /fortnite/api/matchmaking/session/${req.params.sessionId} called`);
    const playlist = await global.kv.get(`playerPlaylist:${req.user.accountId}`);
    let kvDocument = await global.kv.get(`playerCustomKey:${req.user.accountId}`);
    if (!kvDocument) {
        let selectedServer = global.matchmakingPlayerServers?.get(req.user.accountId) || findServerForPlaylist(playlist);
        if (!selectedServer) {
            log.debug("No server found for playlist", playlist);
            return error.createError("errors.com.epicgames.common.matchmaking.playlist.not_found", `No server found for playlist ${playlist}`, [], 1013, "invalid_playlist", 404, res);
        }
        kvDocument = JSON.stringify({
            ip: selectedServer.ip,
            port: selectedServer.port,
            playlist: selectedServer.playlist,
            beaconPort: selectedServer.beaconPort
        });
    }
    let codeKV = JSON.parse(kvDocument);

    res.json({
        "id": req.params.sessionId,
        "ownerId": functions.MakeID().replace(/-/ig, "").toUpperCase(),
        "ownerName": "[DS]fortnite-liveeugcec1c2e30ubrcore0a-z8hj-1968",
        "serverName": "[DS]fortnite-liveeugcec1c2e30ubrcore0a-z8hj-1968",
        "serverAddress": codeKV.ip,
        "serverPort": codeKV.port,
        "maxPublicPlayers": 220,
        "openPublicPlayers": 175,
        "maxPrivatePlayers": 0,
        "openPrivatePlayers": 0,
        "attributes": {
          "REGION_s": "EU",
          "GAMEMODE_s": "FORTATHENA",
          "ALLOWBROADCASTING_b": true,
          "SUBREGION_s": "GB",
          "DCID_s": "FORTNITE-LIVEEUGCEC1C2E30UBRCORE0A-14840880",
          "tenant_s": "Fortnite",
          "MATCHMAKINGPOOL_s": "Any",
          "STORMSHIELDDEFENSETYPE_i": 0,
          "HOTFIXVERSION_i": 0,
          "PLAYLISTNAME_s": codeKV.playlist,
          "SESSIONKEY_s": functions.MakeID().replace(/-/ig, "").toUpperCase(),
          "TENANT_s": "Fortnite",
          "BEACONPORT_i": Number(codeKV.beaconPort) || Number(codeKV.port) || 7777
        },
        "publicPlayers": [],
        "privatePlayers": [],
        "totalPlayers": 45,
        "allowJoinInProgress": false,
        "shouldAdvertise": false,
        "isDedicated": false,
        "usesStats": false,
        "allowInvites": false,
        "usesPresence": false,
        "allowJoinViaPresence": true,
        "allowJoinViaPresenceFriendsOnly": false,
        "buildUniqueId": buildUniqueId[req.user.accountId] || "0",
        "lastUpdated": new Date().toISOString(),
        "started": false
      });
});

app.post("/fortnite/api/matchmaking/session/*/join", (req, res) => {
    log.debug("POST /fortnite/api/matchmaking/session/*/join called");
    res.status(204);
    res.end();
});

app.post("/fortnite/api/matchmaking/session/matchMakingRequest", (req, res) => {
    log.debug("POST /fortnite/api/matchmaking/session/matchMakingRequest called");
    res.json([]);
});

module.exports = app;
