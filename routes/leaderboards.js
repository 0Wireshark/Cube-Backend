const express = require("express");
const app = express.Router();
const User = require("../model/user.js");
const Arena = require("../model/arena.js");
const UserStats = require("../model/userstats.js");
const { verifyToken } = require("../tokenManager/tokenVerify.js");
const playerStats = require("../structs/userStats.js");
const log = require("../structs/log.js");

function getMaxSize(queryValue) {
    const maxSize = Number(queryValue || 100);
    if (!Number.isFinite(maxSize) || maxSize < 1 || maxSize > 150) return null;
    return Math.floor(maxSize);
}

async function getUsersByAccountId(accountIds) {
    const users = await User.find(
        { accountId: { $in: accountIds }, banned: { $ne: true }, isServer: { $ne: true } },
        { accountId: 1, username: 1 }
    ).lean();

    return new Map(users.map(user => [user.accountId, user]));
}

async function buildStatsLeaderboard(leaderboardName, maxSize) {
    const parsed = playerStats.parseStatKey(leaderboardName);
    if (!parsed.field) return [];

    const stats = await UserStats.find({}, { accountId: 1, [parsed.mode]: 1 }).lean();
    const usersByAccountId = await getUsersByAccountId(stats.map(stat => stat.accountId));
    const entries = [];

    for (const stat of stats) {
        const user = usersByAccountId.get(stat.accountId);
        if (!user) continue;

        entries.push({
            displayName: user.username,
            account: user.accountId,
            accountId: user.accountId,
            value: playerStats.getStatValue(stat, parsed.mode, parsed.field)
        });
    }

    return entries
        .sort((a, b) => b.value - a.value)
        .slice(0, maxSize);
}

async function buildArenaLeaderboard(maxSize) {
    const arenaStats = await Arena.find({}, { accountId: 1, hype: 1 })
        .sort({ hype: -1 })
        .limit(maxSize)
        .lean();
    const usersByAccountId = await getUsersByAccountId(arenaStats.map(stat => stat.accountId));
    const entries = [];

    for (const stat of arenaStats) {
        const user = usersByAccountId.get(stat.accountId);
        if (!user) continue;

        entries.push({
            displayName: user.username,
            account: user.accountId,
            accountId: user.accountId,
            value: playerStats.toFiniteNumber(stat.hype)
        });
    }

    return entries;
}

app.get("/*/api/statsv2/leaderboards/:leaderboardName", async (req, res) => {
    log.debug(`GET /*/api/statsv2/leaderboards/${req.params.leaderboardName} called`);

    const maxSize = getMaxSize(req.query.maxSize);
    if (!maxSize) return res.json({ error: "minSize: 1 / maxSize: 150" });

    try {
        const leaderboardName = String(req.params.leaderboardName || "");
        const isArena = leaderboardName.toLowerCase().includes("hype") || leaderboardName.toLowerCase().includes("cubepoints");
        const entries = isArena
            ? await buildArenaLeaderboard(maxSize)
            : await buildStatsLeaderboard(leaderboardName, maxSize);

        res.json({
            maxSize,
            entries
        });
    } catch (err) {
        log.error(`Leaderboard Error: ${err}`);
        res.json({
            maxSize,
            entries: []
        });
    }
});

app.post("/fortnite/api/leaderboards/type/global/stat/:leaderboardName/window/:typeLeaderboard", async (req, res) => {
    log.debug(`POST /fortnite/api/leaderboards/type/global/stat/${req.params.leaderboardName}/window/${req.params.typeLeaderboard} called`);

    try {
        const entries = await buildStatsLeaderboard(req.params.leaderboardName, 150);
        entries.forEach((entry, index) => {
            entry.rank = index + 1;
        });

        res.json({
            statName: req.params.leaderboardName,
            statWindow: req.params.typeLeaderboard,
            entries
        });
    } catch (err) {
        log.error(`Legacy Leaderboard Error: ${err}`);
        res.json({
            statName: req.params.leaderboardName,
            statWindow: req.params.typeLeaderboard,
            entries: []
        });
    }
});

app.post("/*/api/statsv2/query", verifyToken, async (req, res) => {
    log.debug("POST /*/api/statsv2/query called");

    const requestedStats = Array.isArray(req.body.stats) ? req.body.stats : [];
    const owners = Array.isArray(req.body.owners) ? req.body.owners : [];
    if (requestedStats.length === 0 || owners.length === 0) return res.json([]);

    const users = await User.find(
        { accountId: { $in: owners }, banned: { $ne: true }, isServer: { $ne: true } },
        { accountId: 1 }
    ).lean();
    const validOwnerSet = new Set(users.map(user => user.accountId));
    const validOwners = owners.filter(owner => validOwnerSet.has(owner));
    const documents = await Promise.all(validOwners.map(accountId => playerStats.ensureUserStats(accountId)));
    const statsByAccountId = new Map(documents.filter(Boolean).map(stat => [stat.accountId, stat]));
    const response = [];

    for (const owner of validOwners) {
        const stats = statsByAccountId.get(owner);
        if (!stats) continue;

        const statValues = {};
        for (const statKey of requestedStats) {
            const parsed = playerStats.parseStatKey(statKey);
            if (!parsed.field) continue;

            statValues[statKey] = playerStats.getStatValue(stats, parsed.mode, parsed.field);
        }

        response.push({
            accountId: owner,
            endTime: req.body.endTime || 0,
            startTime: req.body.startTime || 0,
            stats: statValues
        });
    }

    res.json(response);
});

app.get("/fortnite/api/game/v2/leaderboards/cohort/:accountId", verifyToken, async (req, res) => {
    log.debug(`GET /fortnite/api/game/v2/leaderboards/cohort/${req.params.accountId} called`);

    const limit = getMaxSize(req.query.maxSize) || 100;
    const users = await User.find(
        { banned: { $ne: true }, isServer: { $ne: true } },
        { accountId: 1 }
    ).limit(limit).lean();
    const accountIds = users.map(user => user.accountId);

    if (!accountIds.includes(req.params.accountId)) accountIds.unshift(req.params.accountId);

    res.json({
        accountId: req.params.accountId,
        cohortAccounts: accountIds,
        accounts: accountIds
    });
});

app.get("/fortnite/api/stats/accountId/:accountId/bulk/window/:windowType", verifyToken, async (req, res) => {
    log.debug(`GET /fortnite/api/stats/accountId/${req.params.accountId}/bulk/window/${req.params.windowType} called`);

    const stats = await playerStats.ensureUserStats(req.params.accountId);
    res.json(playerStats.buildBulkStats(stats, req.params.windowType));
});

app.get("/*/api/statsv2/account/:accountId", verifyToken, async (req, res) => {
    log.debug(`GET /*/api/statsv2/account/${req.params.accountId} called`);

    const stats = await playerStats.ensureUserStats(req.params.accountId);
    res.json(playerStats.buildStatsV2Payload(
        req.params.accountId,
        stats,
        req.query.startTime || 0
    ));
});

module.exports = app;
