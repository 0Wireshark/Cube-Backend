const UserStats = require("../model/userstats.js");

const MODES = ["solo", "duo", "trio", "squad", "ltm"];
const STAT_FIELDS = [
    "placetop1",
    "placetop3",
    "placetop5",
    "placetop6",
    "placetop10",
    "placetop12",
    "placetop25",
    "kills",
    "matchesplayed",
    "minutesplayed",
    "playersoutlived",
    "score"
];

const MODE_TO_LEGACY_PLAYLIST = {
    solo: "2",
    duo: "10",
    trio: "9",
    squad: "9",
    ltm: "2"
};

const MODE_TO_STATSV2_PLAYLIST = {
    solo: "playlist_defaultsolo",
    duo: "playlist_defaultduo",
    trio: "playlist_defaulttrio",
    squad: "playlist_defaultsquad",
    ltm: "playlist_solidgold_solo"
};

const PLACEMENT_FIELDS = {
    solo: ["placetop1", "placetop10", "placetop25"],
    duo: ["placetop1", "placetop5", "placetop12"],
    trio: ["placetop1", "placetop3", "placetop6"],
    squad: ["placetop1", "placetop3", "placetop6"],
    ltm: ["placetop1", "placetop10", "placetop25"]
};

const COMMON_FIELDS = ["score", "kills", "matchesplayed", "minutesplayed", "playersoutlived"];

function createModeStats() {
    return STAT_FIELDS.reduce((stats, field) => {
        stats[field] = 0;
        return stats;
    }, {});
}

function createDefaultStats(accountId) {
    const stats = {
        created: new Date(),
        updated: new Date(),
        accountId
    };

    for (const mode of MODES) {
        stats[mode] = createModeStats();
    }

    return stats;
}

function toFiniteNumber(value, fallback = 0) {
    if (value === undefined || value === null || value === "") return fallback;
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(0, Math.floor(number));
}

function firstValue(source, keys) {
    if (!source || typeof source !== "object") return undefined;

    for (const key of keys) {
        if (source[key] !== undefined && source[key] !== null && source[key] !== "") {
            return source[key];
        }
    }

    return undefined;
}

function firstNumber(source, keys, fallback = 0) {
    return toFiniteNumber(firstValue(source, keys), fallback);
}

function normalizeMode(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) return "solo";

    if (raw === "2" || raw === "playlist_defaultsolo" || raw === "defaultsolo" || raw === "solo") return "solo";
    if (raw === "10" || raw === "playlist_defaultduo" || raw === "defaultduo" || raw === "duo") return "duo";
    if (raw === "9" || raw === "playlist_defaultsquad" || raw === "defaultsquad" || raw === "squad") return "squad";
    if (raw === "playlist_defaulttrio" || raw === "defaulttrio" || raw === "trio") return "trio";
    if (raw === "ltm" || raw.includes("solidgold")) return "ltm";

    if (raw.includes("trio")) return "trio";
    if (raw.includes("squad")) return "squad";
    if (raw.includes("duo")) return "duo";
    if (raw.includes("solo")) return "solo";

    return "solo";
}

function normalizeStatField(value) {
    const raw = String(value || "").toLowerCase().replace(/^br_/, "");
    if (!raw) return "";

    for (const field of [...STAT_FIELDS].sort((a, b) => b.length - a.length)) {
        if (raw === field || raw.includes(field)) return field;
    }

    return "";
}

function parseStatKey(statKey) {
    const raw = String(statKey || "").toLowerCase();
    const legacyPlaylist = raw.match(/(?:^|_)p(2|9|10)(?:_|$)/);

    return {
        mode: legacyPlaylist ? normalizeMode(legacyPlaylist[1]) : normalizeMode(raw),
        field: normalizeStatField(raw)
    };
}

function normalizeDocument(document) {
    const data = document?.toObject ? document.toObject() : (document || {});

    for (const mode of MODES) {
        if (!data[mode] || typeof data[mode] !== "object") data[mode] = createModeStats();

        for (const field of STAT_FIELDS) {
            data[mode][field] = toFiniteNumber(data[mode][field]);
        }
    }

    return data;
}

async function ensureUserStats(accountId) {
    if (!accountId) return null;

    const defaults = createDefaultStats(accountId);
    let stats = await UserStats.findOneAndUpdate(
        { accountId },
        { $setOnInsert: defaults },
        { new: true, upsert: true }
    );

    const normalized = normalizeDocument(stats);
    const missing = {};

    for (const mode of MODES) {
        for (const field of STAT_FIELDS) {
            if (stats[mode]?.[field] === undefined || stats[mode]?.[field] === null) {
                missing[`${mode}.${field}`] = normalized[mode][field];
            }
        }
    }

    if (Object.keys(missing).length > 0) {
        missing.updated = new Date();
        stats = await UserStats.findOneAndUpdate(
            { accountId },
            { $set: missing },
            { new: true }
        );
    }

    return stats;
}

function getStatValue(stats, mode, field) {
    const normalized = normalizeDocument(stats);
    return toFiniteNumber(normalized[mode]?.[field]);
}

function buildStatsV2Payload(accountId, stats, startTime = 0) {
    const normalized = normalizeDocument(stats);
    const payload = {};

    for (const mode of MODES) {
        const playlist = MODE_TO_STATSV2_PLAYLIST[mode];
        if (!playlist) continue;

        for (const field of [...COMMON_FIELDS, ...PLACEMENT_FIELDS[mode]]) {
            payload[`br_${field}_keyboardmouse_m0_${playlist}`] = toFiniteNumber(normalized[mode][field]);
        }
    }

    return {
        accountId,
        endTime: 0,
        startTime,
        stats: payload
    };
}

function buildBulkStats(stats, windowType = "alltime") {
    const normalized = normalizeDocument(stats);
    const entries = [];

    for (const mode of ["solo", "duo", "squad"]) {
        const playlist = MODE_TO_LEGACY_PLAYLIST[mode];
        for (const field of [...COMMON_FIELDS, ...PLACEMENT_FIELDS[mode]]) {
            entries.push({
                name: `br_${field}_pc_m0_p${playlist}`,
                value: toFiniteNumber(normalized[mode][field]),
                window: windowType,
                ownerType: 1
            });
        }
    }

    return entries;
}

function getModeFromEvent(event, fallbackPlaylist) {
    return normalizeMode(firstValue(event, [
        "PlaylistName",
        "GameStatePlaylistName",
        "Playlist",
        "playlist",
        "PlaylistId",
        "playlistId",
        "GameMode",
        "gameMode"
    ]) || fallbackPlaylist);
}

function getMatchId(event) {
    return String(firstValue(event, [
        "MatchId",
        "matchId",
        "GameSessionId",
        "GameSessionID",
        "gameSessionId",
        "SessionId",
        "sessionId",
        "RoundId",
        "roundId"
    ]) || "").trim();
}

function getPlacement(event) {
    return firstNumber(event, [
        "Placement",
        "placement",
        "Place",
        "place",
        "MatchPlacement",
        "matchPlacement",
        "GameResult"
    ], 0);
}

function getMinutesPlayed(event) {
    const minutes = firstNumber(event, [
        "MinutesPlayed",
        "minutesPlayed",
        "TimePlayedMinutes",
        "timePlayedMinutes"
    ], 0);
    if (minutes > 0) return minutes;

    const seconds = firstNumber(event, [
        "SecondsPlayed",
        "secondsPlayed",
        "TimeAlive",
        "timeAlive",
        "TimeAliveSeconds",
        "timeAliveSeconds",
        "SurvivalTimeSeconds",
        "survivalTimeSeconds"
    ], 0);

    return seconds > 0 ? Math.max(1, Math.ceil(seconds / 60)) : 0;
}

function addIncrement(increments, path, amount) {
    const value = toFiniteNumber(amount);
    if (value <= 0) return;
    increments[path] = (increments[path] || 0) + value;
}

function applyPlacement(increments, mode, placement) {
    addIncrement(increments, `${mode}.matchesplayed`, 1);

    if (placement <= 0) return;
    if (placement === 1) addIncrement(increments, `${mode}.placetop1`, 1);

    if (mode === "solo" || mode === "ltm") {
        if (placement <= 10) addIncrement(increments, `${mode}.placetop10`, 1);
        if (placement <= 25) addIncrement(increments, `${mode}.placetop25`, 1);
        return;
    }

    if (mode === "duo") {
        if (placement <= 5) addIncrement(increments, `${mode}.placetop5`, 1);
        if (placement <= 12) addIncrement(increments, `${mode}.placetop12`, 1);
        return;
    }

    if (placement <= 3) addIncrement(increments, `${mode}.placetop3`, 1);
    if (placement <= 6) addIncrement(increments, `${mode}.placetop6`, 1);
}

async function wasMatchAlreadyRecorded(accountId, matchId) {
    if (!accountId || !matchId || !global.kv) return false;

    const key = `careerStats:match:${accountId}:${matchId}`;
    const existing = await global.kv.get(key);
    if (existing) return true;

    await global.kv.setTTL(key, "1", 60 * 60 * 12);
    return false;
}

async function recordDatarouterEvents(accountId, events, fallbackPlaylist) {
    if (!accountId || !Array.isArray(events) || events.length === 0) return null;

    await ensureUserStats(accountId);

    const increments = {};
    const finalMatchesInBatch = new Set();

    for (const event of events) {
        if (!event || typeof event !== "object") continue;

        const eventName = String(event.EventName || event.eventName || "");
        const providerType = String(event.ProviderType || event.providerType || "Client");
        if (providerType && providerType !== "Client") continue;

        const mode = getModeFromEvent(event, fallbackPlaylist);
        const matchId = getMatchId(event);
        const matchKey = matchId || `${mode}:${eventName}`;
        const kills = firstNumber(event, [
            "PlayerKilledPlayerEventCount",
            "playerKilledPlayerEventCount",
            "Eliminations",
            "eliminations",
            "Kills",
            "kills",
            "KillCount",
            "killCount",
            "PlayerKills",
            "playerKills"
        ], 0);

        if (eventName === "Combat.AthenaClientEngagement") {
            addIncrement(increments, `${mode}.kills`, kills);
            addIncrement(increments, `${mode}.score`, kills * 100);
            continue;
        }

        if (eventName !== "Athena.ClientWonMatch" && eventName !== "Combat.ClientPlayerDeath") {
            continue;
        }

        if (finalMatchesInBatch.has(matchKey)) continue;
        if (matchId && await wasMatchAlreadyRecorded(accountId, matchId)) continue;
        finalMatchesInBatch.add(matchKey);

        const placement = eventName === "Athena.ClientWonMatch" ? 1 : getPlacement(event);
        const minutesPlayed = getMinutesPlayed(event);
        const playersOutlived = firstNumber(event, [
            "PlayersOutlived",
            "playersOutlived",
            "NumPlayersOutlived",
            "numPlayersOutlived"
        ], 0);
        const score = firstNumber(event, [
            "Score",
            "score",
            "TotalScore",
            "totalScore",
            "MatchScore",
            "matchScore"
        ], 0);

        applyPlacement(increments, mode, placement);
        addIncrement(increments, `${mode}.minutesplayed`, minutesPlayed);
        addIncrement(increments, `${mode}.playersoutlived`, playersOutlived);
        addIncrement(increments, `${mode}.score`, score || (placement === 1 ? 1000 : 0));
        if (kills > 0 && eventName === "Athena.ClientWonMatch") {
            addIncrement(increments, `${mode}.kills`, kills);
            addIncrement(increments, `${mode}.score`, kills * 100);
        }
    }

    if (Object.keys(increments).length === 0) {
        return await UserStats.findOne({ accountId });
    }

    return await UserStats.findOneAndUpdate(
        { accountId },
        {
            $inc: increments,
            $set: { updated: new Date() }
        },
        { new: true }
    );
}

module.exports = {
    COMMON_FIELDS,
    MODE_TO_LEGACY_PLAYLIST,
    MODE_TO_STATSV2_PLAYLIST,
    MODES,
    PLACEMENT_FIELDS,
    STAT_FIELDS,
    buildBulkStats,
    buildStatsV2Payload,
    createDefaultStats,
    ensureUserStats,
    getStatValue,
    normalizeMode,
    normalizeStatField,
    parseStatKey,
    recordDatarouterEvents,
    toFiniteNumber
};
