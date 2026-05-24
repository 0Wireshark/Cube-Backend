const DEFAULT_TTL_MS = 15000;

function normalizePlaylist(playlist) {
    return typeof playlist === "string" ? playlist.trim().toLowerCase() : "";
}

function isValidPort(port) {
    return Number.isInteger(port) && port > 0 && port <= 65535;
}

function normalizeServer(server) {
    if (!server || typeof server !== "object") return null;

    const ip = String(server.ip || server.host || "").trim();
    const port = Number(server.port) || 7777;
    const beaconPort = Number(server.beaconPort) || port;
    if (!ip || !isValidPort(port) || !isValidPort(beaconPort)) return null;

    return {
        ip,
        port,
        beaconPort,
        playlist: normalizePlaylist(server.playlist || "")
    };
}

function getStore() {
    global.matchmakingGameServerStatus = global.matchmakingGameServerStatus || new Map();
    return global.matchmakingGameServerStatus;
}

function getKey(server) {
    const normalized = normalizeServer(server);
    if (!normalized) return "";
    return `${normalized.ip}:${normalized.port}:${normalized.beaconPort}:${normalized.playlist}`;
}

function sameEndpoint(left, right) {
    return left.ip === right.ip
        && left.port === right.port
        && left.beaconPort === right.beaconPort;
}

function cleanup(now = Date.now()) {
    const store = getStore();
    for (const [key, status] of store.entries()) {
        if (!status || status.expiresAt <= now) store.delete(key);
    }
}

function markOnline(server, ttlMs = DEFAULT_TTL_MS) {
    const normalized = normalizeServer(server);
    if (!normalized) return null;

    const now = Date.now();
    const ttl = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0 ? Number(ttlMs) : DEFAULT_TTL_MS;
    const status = {
        ...normalized,
        updatedAt: now,
        expiresAt: now + ttl
    };

    getStore().set(getKey(normalized), status);
    cleanup(now);
    return status;
}

function isOnline(server, now = Date.now()) {
    const normalized = normalizeServer(server);
    if (!normalized) return false;

    cleanup(now);
    const store = getStore();
    const exact = store.get(getKey(normalized));
    if (exact && exact.expiresAt > now) return true;

    for (const status of store.values()) {
        if (status.expiresAt <= now) continue;
        if (sameEndpoint(status, normalized)) return true;
    }

    return false;
}

function snapshot(now = Date.now()) {
    cleanup(now);
    return [...getStore().values()].map(status => ({
        ip: status.ip,
        port: status.port,
        beaconPort: status.beaconPort,
        playlist: status.playlist,
        updatedAt: new Date(status.updatedAt).toISOString(),
        expiresAt: new Date(status.expiresAt).toISOString()
    }));
}

module.exports = {
    cleanup,
    isOnline,
    markOnline,
    normalizeServer,
    snapshot
};
