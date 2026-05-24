const functions = require("../structs/functions.js");
const log = require("../structs/log.js");
const config = require("../structs/config.js");
const gsAuth = require("../structs/gsAuth.js");
const gameServerStatus = require("../structs/gameServerStatus.js");
const crypto = require("crypto");
const net = require("net");

let queue = [];
let matchTimer = null;
let isProcessingQueue = false;

const MATCHMAKING_TICK_MS = 500;
const FAST_STATUS_DELAY_MS = 150;
const PLAY_ASSIGNMENT_DELAY_MS = 100;
const SERVER_CHECK_TIMEOUT_MS = 1500;
const NO_SERVER_LOG_INTERVAL_MS = 5000;

const lastNoServerLog = new Map();

function normalizePlaylist(playlist) {
    return typeof playlist === "string" ? playlist.toLowerCase() : "";
}

function isValidPort(port) {
    return Number.isInteger(port) && port > 0 && port <= 65535;
}

function parseServerEntry(serverEntry, forcedPlaylist) {
    if (typeof serverEntry !== "string") return null;

    const parts = serverEntry.split(":").map(part => part.trim());
    if (parts.length < 2) return null;

    const port = Number(parts[1]) || 7777;
    const beaconPort = Number(parts[3]) || port;
    if (!parts[0] || !isValidPort(port) || !isValidPort(beaconPort)) return null;

    return {
        ip: parts[0],
        port,
        playlist: forcedPlaylist || parts[2] || "playlist_defaultsolo",
        beaconPort
    };
}

function getServersForPlaylist(playlist) {
    const servers = Array.isArray(config.gameServerIP) ? config.gameServerIP : [];
    const normalizedPlaylist = normalizePlaylist(playlist);
    const parsedServers = servers.map(server => parseServerEntry(server)).filter(Boolean);

    const playlistServers = parsedServers.filter(server => normalizePlaylist(server.playlist) === normalizedPlaylist);
    if (playlistServers.length > 0) return playlistServers;

    if (parsedServers[0]) return [{ ...parsedServers[0], playlist: playlist || parsedServers[0].playlist }];
    return [];
}

function normalizeServer(server, fallbackPlaylist) {
    if (typeof server === "string") return parseServerEntry(server, fallbackPlaylist);
    if (!server || typeof server !== "object") return null;

    const ip = String(server.ip || "").trim();
    const port = Number(server.port) || 7777;
    const beaconPort = Number(server.beaconPort) || port;
    if (!ip || !isValidPort(port) || !isValidPort(beaconPort)) return null;

    return {
        ip,
        port,
        playlist: server.playlist || fallbackPlaylist || "playlist_defaultsolo",
        beaconPort
    };
}

function normalizeServerList(servers, fallbackPlaylist) {
    if (!Array.isArray(servers)) return [];

    return servers
        .map(server => normalizeServer(server, fallbackPlaylist))
        .filter(Boolean);
}

function getServersForPlayer(player) {
    const routeServers = normalizeServerList(player.servers, player.playlist);
    if (routeServers.length > 0) return routeServers;

    const routeServer = normalizeServer(player.server, player.playlist);
    if (routeServer) return [routeServer];

    return getServersForPlaylist(player.playlist);
}

function base64UrlDecode(value) {
    const padded = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(padded.padEnd(padded.length + ((4 - padded.length % 4) % 4), "="), "base64").toString("utf8");
}

function base64UrlSignature(value) {
    return value
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function getMatchmakerPayloadSecret() {
    return String(config.matchmakerPayloadSecret || config.gsAuth?.secret || "");
}

function isValidPayloadSignature(encodedPayload, signature) {
    const secret = getMatchmakerPayloadSecret();
    if (!secret) return true;
    if (!signature) return false;

    const expected = base64UrlSignature(
        crypto.createHmac("sha256", secret).update(encodedPayload, "utf8").digest("base64")
    );
    const expectedBuffer = Buffer.from(expected);
    const signatureBuffer = Buffer.from(signature);

    return expectedBuffer.length === signatureBuffer.length && crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
}

function decodeMatchmakerRoute(payload) {
    if (typeof payload !== "string") return null;

    const parts = payload.split(".");
    if (parts[0] !== "v1" || parts.length < 2) return null;
    if (!isValidPayloadSignature(parts[1], parts[2] || "")) {
        log.debug("Matchmaker payload signature rejected.");
        return null;
    }

    try {
        const route = JSON.parse(base64UrlDecode(parts[1]));
        if (!route || typeof route !== "object") return null;

        return {
            accountId: typeof route.accountId === "string" ? route.accountId : null,
            playlist: typeof route.playlist === "string" ? route.playlist : "playlist_defaultsolo",
            server: route.server || null,
            servers: Array.isArray(route.servers) ? route.servers : []
        };
    } catch (err) {
        log.debug(`Matchmaker payload decode failed: ${err.message}`);
        return null;
    }
}

function getRouteForPayload(payload) {
    return global.matchmakingTickets?.get(payload) || decodeMatchmakerRoute(payload) || null;
}

function socketCheck(ip, port) {
    return new Promise(resolve => {
        const socket = new net.Socket();
        let done = false;

        const finish = (ok) => {
            if (done) return;
            done = true;
            socket.destroy();
            resolve(ok);
        };

        socket.setTimeout(SERVER_CHECK_TIMEOUT_MS);
        socket.once("connect", () => finish(true));
        socket.once("timeout", () => finish(false));
        socket.once("error", () => finish(false));

        try {
            socket.connect(port, ip);
        } catch {
            finish(false);
        }
    });
}

async function isServerOpen(server, checkCache) {
    if (!server || !server.ip) return false;
    if (gameServerStatus.isOnline(server)) return true;

    const cacheKey = `${server.ip}:${server.port}:${server.beaconPort}`;
    if (checkCache.has(cacheKey)) return checkCache.get(cacheKey);

    const checkPromise = (async () => {
        if (await socketCheck(server.ip, server.beaconPort)) return true;
        if (server.port !== server.beaconPort) return socketCheck(server.ip, server.port);
        return false;
    })();

    checkCache.set(cacheKey, checkPromise);
    return checkPromise;
}

async function firstOpenServer(servers, checkCache) {
    for (const server of servers) {
        if (await isServerOpen(server, checkCache)) return server;
    }

    return null;
}

function shouldLogNoServer(playlist) {
    const key = normalizePlaylist(playlist) || "unknown";
    const now = Date.now();
    const lastLog = lastNoServerLog.get(key) || 0;
    if (now - lastLog < NO_SERVER_LOG_INTERVAL_MS) return false;
    lastNoServerLog.set(key, now);
    return true;
}

function formatOnlineServers() {
    const servers = gameServerStatus.snapshot();
    if (servers.length === 0) return "none";

    return servers
        .map(server => `${server.ip}:${server.port}/${server.playlist || "any"} expires=${server.expiresAt}`)
        .join(", ");
}

function isOpen(ws) {
    return ws && ws.readyState === 1;
}

function send(ws, payload) {
    if (!isOpen(ws)) return;
    try {
        ws.send(JSON.stringify(payload));
    } catch (err) {
        log.error(`Matchmaker send failed: ${err.message}`);
    }
}

module.exports = async (ws, matchmakingPayload) => {
    const ticketId = functions.MakeID().replace(/-/ig, "");
    const matchId = functions.MakeID().replace(/-/ig, "");
    const sessionId = functions.MakeID().replace(/-/ig, "");
    const route = getRouteForPayload(matchmakingPayload);
    const playlist = route?.playlist || "playlist_defaultsolo";
    const server = normalizeServer(route?.server, playlist);
    const servers = normalizeServerList(route?.servers, playlist);

    const player = {
        ws,
        ticketId,
        matchId,
        sessionId,
        state: "Connecting",
        matchmakingPayload,
        accountId: route?.accountId || null,
        playlist,
        server,
        servers,
        joinedAt: Date.now()
    };

    if (player.accountId) queue = queue.filter(p => p.accountId !== player.accountId);
    queue.push(player);
    log.debug(`Player joined matchmaking queue. Total: ${queue.length}`);

    ws.on("close", () => {
        queue = queue.filter(p => p !== player);
        log.debug(`Player left matchmaking queue. Total: ${queue.length}`);
    });

    ws.on("error", () => {
        queue = queue.filter(p => p !== player);
    });

    send(ws, { name: "StatusUpdate", payload: { state: "Connecting" } });
    await functions.sleep(FAST_STATUS_DELAY_MS);
    if (!isOpen(ws)) return;

    send(ws, {
        name: "StatusUpdate",
        payload: {
            totalPlayers: 1,
            connectedPlayers: 1,
            state: "Waiting"
        }
    });
    await functions.sleep(FAST_STATUS_DELAY_MS);
    if (!isOpen(ws)) return;

    player.state = "Queued";
    sendQueued(player);
    startMatchmakingTimer();
    processMatchmakingQueue();
};

function sendQueued(player) {
    const queuedPlayers = queue.filter(p => p.state === "Queued").length;
    const waited = Math.floor((Date.now() - player.joinedAt) / 1000);

    send(player.ws, {
        name: "StatusUpdate",
        payload: {
            ticketId: player.ticketId,
            queuedPlayers,
            estimatedWaitSec: Math.max(1, 3 - waited),
            status: {},
            state: "Queued"
        }
    });
}

function startMatchmakingTimer() {
    if (matchTimer) return;

    matchTimer = setInterval(processMatchmakingQueue, MATCHMAKING_TICK_MS);
}

async function processMatchmakingQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;
    const checkCache = new Map();

    try {
        queue = queue.filter(player => isOpen(player.ws) && player.state === "Queued");

        if (queue.length === 0) {
            if (matchTimer) clearInterval(matchTimer);
            matchTimer = null;
            return;
        }

        for (const player of [...queue]) {
            sendQueued(player);

            const server = await firstOpenServer(getServersForPlayer(player), checkCache);
            if (!server) {
                if (shouldLogNoServer(player.playlist)) {
                    log.debug(`No open game server for playlist ${player.playlist}. Heartbeats: ${formatOnlineServers()}. Keeping players queued.`);
                }
                continue;
            }

            player.state = "Matched";
            queue = queue.filter(p => p !== player);
            log.debug(`Matchmaker assigned ${server.ip}:${server.port} for playlist ${server.playlist || player.playlist}.`);

            if (player.accountId) {
                global.matchmakingPlayerServers = global.matchmakingPlayerServers || new Map();
                global.matchmakingPlayerServers.set(player.accountId, {
                    ip: server.ip,
                    port: server.port,
                    playlist: server.playlist,
                    beaconPort: server.beaconPort
                });
                if (config.gsAuth && config.gsAuth.enable === true) {
                    gsAuth.createJoinReservation({
                        accountId: player.accountId,
                        playlist: server.playlist || player.playlist,
                        server,
                        matchId: player.matchId,
                        sessionId: player.sessionId,
                        source: "matchmaker-play"
                    });
                }
            }

            send(player.ws, {
                name: "StatusUpdate",
                payload: {
                    matchId: player.matchId,
                    state: "SessionAssignment"
                }
            });

            await functions.sleep(PLAY_ASSIGNMENT_DELAY_MS);
            if (!isOpen(player.ws)) continue;

            send(player.ws, {
                name: "Play",
                payload: {
                    matchId: player.matchId,
                    sessionId: player.sessionId,
                    joinDelaySec: 0
                }
            });
        }
    } finally {
        isProcessingQueue = false;
    }
}
