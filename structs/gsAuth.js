const crypto = require("crypto");
const config = require("./config.js");

const DEFAULT_JOIN_TTL_SECONDS = 120;
const DEFAULT_CLOCK_SKEW_SECONDS = 30;
const DEFAULT_NONCE_TTL_SECONDS = 90;

function getAuthConfig() {
    return config.gsAuth || {};
}

function getSharedSecrets() {
    const auth = getAuthConfig();
    const envName = String(auth.secretEnv || "CUBE_GS_BACKEND_SECRET").trim();
    const values = [
        envName ? process.env[envName] : "",
        auth.secret
    ];

    return [...new Set(values
        .map(value => String(value || ""))
        .filter(value => value.length >= 32))];
}

function positiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function getJoinTtlSeconds() {
    const auth = getAuthConfig();
    return positiveNumber(auth.joinTtlSeconds ?? auth.ttlSeconds, DEFAULT_JOIN_TTL_SECONDS);
}

function getClockSkewMs() {
    return positiveNumber(getAuthConfig().clockSkewSeconds, DEFAULT_CLOCK_SKEW_SECONDS) * 1000;
}

function getNonceTtlMs() {
    return positiveNumber(getAuthConfig().nonceTtlSeconds, DEFAULT_NONCE_TTL_SECONDS) * 1000;
}

function ensureStores() {
    global.gsJoinReservations = global.gsJoinReservations || new Map();
    global.gsAuthNonces = global.gsAuthNonces || new Map();
    global.gsJoinAllow = global.gsJoinAllow || new Map();
    global.gsJoinTtlSeconds = getJoinTtlSeconds();
}

function cleanupStores(now = Date.now()) {
    ensureStores();

    for (const [key, reservation] of global.gsJoinReservations.entries()) {
        if (!reservation || reservation.expiresAt <= now || reservation.consumed === true) {
            global.gsJoinReservations.delete(key);
        }
    }

    for (const [key, expiresAt] of global.gsAuthNonces.entries()) {
        if (!expiresAt || expiresAt <= now) {
            global.gsAuthNonces.delete(key);
        }
    }

    for (const [accountId, expiresAt] of global.gsJoinAllow.entries()) {
        if (expiresAt > 0 && expiresAt <= now) {
            global.gsJoinAllow.delete(accountId);
        }
    }
}

function normalizeAccountId(raw) {
    if (typeof raw !== "string") return "";
    let value = raw.trim();
    if (!value) return "";

    if (value.startsWith("MCP:") && value.length >= 36) {
        value = value.slice(4);
    }

    if (value.length === 36 && value.startsWith("1110")) {
        const rest = value.slice(4);
        if (/^[0-9a-fA-F]{32}$/.test(rest)) return rest.toLowerCase();
    }

    const matches = value.match(/[0-9a-fA-F]{32}/g);
    if (matches && matches.length > 0) {
        return matches[matches.length - 1].toLowerCase();
    }

    return value.toLowerCase();
}

function normalizePlaylist(raw) {
    if (typeof raw !== "string") return "";
    let value = raw.trim().toLowerCase();
    if (!value) return "";

    const slash = value.lastIndexOf("/");
    if (slash >= 0) value = value.slice(slash + 1);

    const dot = value.indexOf(".");
    if (dot >= 0) value = value.slice(0, dot);

    return value;
}

function normalizeServer(server) {
    if (!server || typeof server !== "object") return null;

    const ip = String(server.ip || "").trim();
    const port = Number(server.port) || 7777;
    const beaconPort = Number(server.beaconPort) || port;
    if (!ip || port < 1 || port > 65535 || beaconPort < 1 || beaconPort > 65535) {
        return null;
    }

    return {
        ip,
        port,
        beaconPort,
        playlist: normalizePlaylist(server.playlist || "")
    };
}

function createJoinReservation({ accountId, playlist, server, matchId, sessionId, source } = {}) {
    ensureStores();

    const normalizedAccountId = normalizeAccountId(accountId);
    if (!normalizedAccountId) return null;

    const now = Date.now();
    const ttlSeconds = getJoinTtlSeconds();
    const normalizedServer = normalizeServer(server);
    const normalizedPlaylist = normalizePlaylist(playlist || normalizedServer?.playlist || "");
    const reservation = {
        accountId: String(accountId || ""),
        normalizedAccountId,
        playlist: normalizedPlaylist,
        server: normalizedServer,
        matchId: matchId || null,
        sessionId: sessionId || null,
        source: source || "unknown",
        issuedAt: now,
        expiresAt: now + (ttlSeconds * 1000),
        consumed: false
    };

    global.gsJoinReservations.set(normalizedAccountId, reservation);
    global.gsJoinAllow.set(String(accountId || normalizedAccountId), reservation.expiresAt);
    global.gsJoinAllow.set(normalizedAccountId, reservation.expiresAt);

    cleanupStores(now);
    return reservation;
}

function consumeJoinReservation({ accountId, playlist, serverId } = {}) {
    ensureStores();

    const normalizedAccountId = normalizeAccountId(accountId);
    if (!normalizedAccountId) {
        return { ok: false, reason: "missing_account" };
    }

    const reservation = global.gsJoinReservations.get(normalizedAccountId);
    if (!reservation) {
        return { ok: false, reason: "no_reservation", accountId: normalizedAccountId };
    }

    const now = Date.now();
    if (reservation.expiresAt <= now) {
        global.gsJoinReservations.delete(normalizedAccountId);
        return { ok: false, reason: "expired", accountId: normalizedAccountId };
    }

    if (reservation.consumed === true) {
        global.gsJoinReservations.delete(normalizedAccountId);
        return { ok: false, reason: "already_consumed", accountId: normalizedAccountId };
    }

    const requestedPlaylist = normalizePlaylist(playlist || "");
    if (requestedPlaylist && reservation.playlist && requestedPlaylist !== reservation.playlist) {
        return {
            ok: false,
            reason: "playlist_mismatch",
            accountId: normalizedAccountId,
            expectedPlaylist: reservation.playlist,
            requestedPlaylist
        };
    }

    reservation.consumed = true;
    reservation.consumedAt = now;
    reservation.serverId = serverId || null;

    if (getAuthConfig().consumeOnValidate !== false) {
        global.gsJoinReservations.delete(normalizedAccountId);
        global.gsJoinAllow.delete(String(accountId || ""));
        global.gsJoinAllow.delete(normalizedAccountId);
    }

    return { ok: true, accountId: normalizedAccountId, reservation };
}

function getHeader(req, name) {
    const value = req.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
}

function timingSafeHexEqual(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false;
    if (!/^[0-9a-fA-F]+$/.test(a) || !/^[0-9a-fA-F]+$/.test(b)) return false;

    const left = Buffer.from(a, "hex");
    const right = Buffer.from(b, "hex");
    if (left.length !== right.length) return false;

    return crypto.timingSafeEqual(left, right);
}

function getAllowedServerIds() {
    const auth = getAuthConfig();
    if (Array.isArray(auth.allowedServerIds)) {
        return auth.allowedServerIds.map(value => String(value || "").trim()).filter(Boolean);
    }
    if (auth.serverId) return [String(auth.serverId).trim()].filter(Boolean);
    return [];
}

function normalizeIp(ip) {
    let value = String(ip || "").trim();
    if (!value) return "";
    if (value.startsWith("::ffff:")) value = value.slice(7);
    if (value.includes(",")) value = value.split(",")[0].trim();
    return value.toLowerCase();
}

function getRequestIp(req) {
    return normalizeIp(req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || "");
}

function getAllowedSourceIps() {
    const auth = getAuthConfig();
    if (!Array.isArray(auth.allowedSourceIps)) return [];
    return auth.allowedSourceIps.map(normalizeIp).filter(Boolean);
}

function verifySignedRequest(req) {
    ensureStores();

    const auth = getAuthConfig();
    if (auth.enable !== true) {
        return { ok: true, disabled: true, serverId: "disabled" };
    }

    const secrets = getSharedSecrets();
    if (secrets.length <= 0) {
        return { ok: false, status: 500, reason: "server_secret_not_configured" };
    }

    const serverId = String(getHeader(req, "x-gs-id") || "").trim();
    const timestampRaw = String(getHeader(req, "x-gs-timestamp") || "").trim();
    const nonce = String(getHeader(req, "x-gs-nonce") || "").trim();
    const signature = String(getHeader(req, "x-gs-signature") || "").trim();

    if (!serverId || !timestampRaw || !nonce || !signature) {
        return { ok: false, status: 401, reason: "missing_signature_headers" };
    }

    const allowedServerIds = getAllowedServerIds();
    if (allowedServerIds.length > 0 && !allowedServerIds.includes(serverId)) {
        return { ok: false, status: 403, reason: "server_id_not_allowed", serverId };
    }

    const allowedSourceIps = getAllowedSourceIps();
    const requestIp = getRequestIp(req);
    if (allowedSourceIps.length > 0 && !allowedSourceIps.includes(requestIp)) {
        return { ok: false, status: 403, reason: "source_ip_not_allowed", serverId, requestIp };
    }

    if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(nonce)) {
        return { ok: false, status: 401, reason: "bad_nonce" };
    }

    const timestampNumber = Number(timestampRaw);
    const timestampMs = timestampNumber < 100000000000 ? timestampNumber * 1000 : timestampNumber;
    if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > getClockSkewMs()) {
        return { ok: false, status: 401, reason: "timestamp_out_of_window", serverId };
    }

    const nonceKey = `${serverId}:${nonce}`;
    if (global.gsAuthNonces.has(nonceKey)) {
        return { ok: false, status: 401, reason: "nonce_replay", serverId };
    }

    const rawBody = typeof req.rawBody === "string" ? req.rawBody : JSON.stringify(req.body || {});
    const signedPayload = `${timestampRaw}.${nonce}.${rawBody}`;
    const hasValidSignature = secrets.some(secret => {
        const expected = crypto.createHmac("sha256", secret).update(signedPayload, "utf8").digest("hex");
        return timingSafeHexEqual(expected, signature);
    });

    if (!hasValidSignature) {
        return { ok: false, status: 401, reason: "bad_signature", serverId };
    }

    global.gsAuthNonces.set(nonceKey, Date.now() + getNonceTtlMs());
    cleanupStores();
    return { ok: true, serverId };
}

module.exports = {
    cleanupStores,
    consumeJoinReservation,
    createJoinReservation,
    ensureStores,
    normalizeAccountId,
    normalizePlaylist,
    normalizeServer,
    verifySignedRequest
};
