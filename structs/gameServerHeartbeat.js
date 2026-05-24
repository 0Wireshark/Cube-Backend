const crypto = require("crypto");
const axios = require("axios");
const config = require("./config.js");
const gameServerStatus = require("./gameServerStatus.js");
const log = require("./log.js");

function getHeartbeatSecret() {
    return String(config.matchmakerHeartbeatSecret || config.gsAuth?.secret || "");
}

function getProvidedSecret(req) {
    const headerSecret = req.headers["x-gs-secret"];
    if (typeof headerSecret === "string") return headerSecret;
    if (Array.isArray(headerSecret)) return headerSecret[0] || "";
    return String(req.body?.secret || req.query?.secret || "");
}

function timingSafeEqual(left, right) {
    if (!left || !right) return false;

    const leftBuffer = Buffer.from(String(left));
    const rightBuffer = Buffer.from(String(right));
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isAuthorized(req) {
    const expectedSecret = getHeartbeatSecret();
    if (!expectedSecret) return true;
    return timingSafeEqual(getProvidedSecret(req), expectedSecret);
}

function getTtlMs(body) {
    const ttlSeconds = Number(body?.ttlSeconds || config.matchmakerHeartbeatTtlSeconds || 15);
    return Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds * 1000 : 15000;
}

function getHeartbeatServers(body) {
    if (Array.isArray(body?.servers)) return body.servers;

    return [{
        ip: body?.ip,
        port: body?.port,
        playlist: body?.playlist,
        beaconPort: body?.beaconPort
    }];
}

function getMatchmakerHeartbeatUrl() {
    const raw = String(config.matchmakerIP || "").trim();
    if (!raw) return "";

    if (raw.startsWith("wss://")) return `https://${raw.slice(6).replace(/\/+$/g, "")}/gs/heartbeat`;
    if (raw.startsWith("ws://")) return `http://${raw.slice(5).replace(/\/+$/g, "")}/gs/heartbeat`;
    if (raw.startsWith("https://") || raw.startsWith("http://")) return `${raw.replace(/\/+$/g, "")}/gs/heartbeat`;
    return `http://${raw.replace(/\/+$/g, "")}/gs/heartbeat`;
}

async function forwardToMatchmaker(req, body) {
    if (req.headers["x-gs-heartbeat-forwarded"] === "1") return;

    const url = getMatchmakerHeartbeatUrl();
    if (!url) return;

    try {
        await axios.post(url, body, {
            timeout: 2000,
            headers: {
                "content-type": "application/json",
                "x-gs-secret": getProvidedSecret(req),
                "x-gs-heartbeat-forwarded": "1"
            },
            validateStatus: status => status >= 200 && status < 300
        });
        log.debug(`GS heartbeat forwarded to matchmaker ${url}`);
    } catch (err) {
        log.error(`GS heartbeat forward failed to ${url}: ${err.message}`);
    }
}

function registerRoutes(app, options = {}) {
    app.post("/gs/heartbeat", (req, res) => {
        if (!isAuthorized(req)) {
            log.error(`GS heartbeat denied: bad secret (ip=${req.ip})`);
            return res.status(403).json({ ok: false, reason: "bad_secret" });
        }

        const ttlMs = getTtlMs(req.body || {});
        const statuses = getHeartbeatServers(req.body || {})
            .map(server => gameServerStatus.markOnline(server, ttlMs))
            .filter(Boolean);

        if (statuses.length === 0) {
            return res.status(400).json({ ok: false, reason: "invalid_server" });
        }

        for (const status of statuses) {
            log.debug(`GS heartbeat OK ${status.ip}:${status.port} playlist=${status.playlist || "any"}`);
        }

        if (options.forwardToMatchmaker === true) {
            forwardToMatchmaker(req, req.body || {});
        }

        return res.json({ ok: true, servers: statuses.length });
    });

    app.get("/gs/status", (req, res) => {
        if (!isAuthorized(req)) {
            return res.status(403).json({ ok: false, reason: "bad_secret" });
        }

        return res.json({ ok: true, servers: gameServerStatus.snapshot() });
    });
}

module.exports = {
    registerRoutes
};
