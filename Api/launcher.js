const express = require("express");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");
const axios = require("axios");
const User = require("../model/user.js");
const Friends = require("../model/friends.js");
const UserStats = require("../model/userstats.js");
const Arena = require("../model/arena.js");
const Profile = require("../model/profiles.js");
const log = require("../structs/log.js");
const config = require("../structs/config.js");
const discordLauncherAuth = require("../structs/discordLauncherAuth.js");
const friendManager = require("../structs/friend.js");
const gifting = require("../structs/gifting.js");
const launcherBeta = require("../structs/launcherBeta.js");
const launcherSettings = require("../structs/launcherSettings.js");

const app = express.Router();
const LAUNCHER_SECRET = config.launchOnly?.launcherSecret || "ad75d3ee-1819-4e34-b460-d48b04c1c43c";
const LEADERBOARD_LIMIT_MAX = 100;
const LEADERBOARD_CACHE_TTL_MS = 60 * 1000;
const COSMETIC_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const USERNAME_MIN_LENGTH = 3;
const USERNAME_MAX_LENGTH = 16;
const USERNAME_ALLOWED_PATTERN = /^[A-Za-z0-9_.-]+$/;

let leaderboardCache = {
    expiresAt: 0,
    payload: null
};

const cosmeticCache = new Map();

function loadLauncherBackgroundDataUri() {
    const candidates = [
        path.resolve(__dirname, "..", "..", "..", "launcher cube v2", "assets", "images", "background.png"),
        path.resolve(process.cwd(), "..", "..", "launcher cube v2", "assets", "images", "background.png")
    ];

    for (const filePath of candidates) {
        try {
            if (!fs.existsSync(filePath)) continue;
            const imageBuffer = fs.readFileSync(filePath);
            return `data:image/png;base64,${imageBuffer.toString("base64")}`;
        } catch (_error) {}
    }

    return "";
}

async function getUserRoleInfoForLauncher(user) {
    if (!user?.discordId) {
        return {
            name: user?.discordRoleName || "",
            color: Number(user?.discordRoleColor) || 0,
            roles: []
        };
    }

    return discordLauncherAuth.refreshGuildRoleInfoForUser(config, user);
}

function getLaunchSessionToken(req) {
    return String(req.headers["x-launch-session-token"] || req.body?.launchSessionToken || req.query?.launchSessionToken || "").trim();
}

async function getLauncherSessionUser(req) {
    const authorization = discordLauncherAuth.getLaunchAuthorization(getLaunchSessionToken(req));
    if (!authorization || authorization.expiresAt <= Date.now()) return null;
    return User.findOne({ accountId: authorization.accountId });
}

function normalizeFriendsList(friends) {
    const list = friends?.list || {};
    return {
        accepted: Array.isArray(list.accepted) ? list.accepted : [],
        incoming: Array.isArray(list.incoming) ? list.incoming : [],
        outgoing: Array.isArray(list.outgoing) ? list.outgoing : [],
        blocked: Array.isArray(list.blocked) ? list.blocked : []
    };
}

function getFriendAccountId(entry) {
    return typeof entry === "string" ? entry : entry?.accountId;
}

async function buildLauncherFriendsPayload(accountId) {
    const friends = await Friends.findOne({ accountId }).lean();
    const list = normalizeFriendsList(friends);
    const ids = Array.from(new Set([
        ...list.accepted,
        ...list.incoming,
        ...list.outgoing,
        ...list.blocked
    ].map(getFriendAccountId).filter(Boolean)));
    const users = ids.length > 0 ? await User.find({ accountId: { $in: ids }, banned: false }).lean() : [];
    const userById = new Map(users.map(user => [user.accountId, user]));
    const onlineIds = new Set((global.Clients || []).map(client => client.accountId).filter(Boolean));

    const formatEntry = (entry) => {
        const friendAccountId = getFriendAccountId(entry);
        const user = userById.get(friendAccountId) || {};
        return {
            accountId: friendAccountId,
            displayName: user.username || entry?.displayName || friendAccountId,
            profilePicture: user.discordAvatar || "",
            profilePictureUrl: user.discordAvatar || "",
            online: onlineIds.has(friendAccountId),
            status: onlineIds.has(friendAccountId) ? "online" : "offline",
            created: entry?.created
        };
    };

    return {
        friends: list.accepted.map(entry => ({
            ...formatEntry(entry),
            created: gifting.getClientGiftEligibleCreated(entry?.created)
        })),
        incoming: list.incoming.map(formatEntry),
        outgoing: list.outgoing.map(formatEntry),
        blocklist: list.blocked.map(entry => ({ accountId: getFriendAccountId(entry) })),
        settings: {
            acceptInvites: "public"
        }
    };
}

function getLauncherVersionConfig() {
    const versionConfig = {
        ...(config.launcherVersion || {}),
        ...(launcherSettings.getSettings().launcherVersion || {})
    };
    return {
        minimum: String(versionConfig.minimum || "1.0"),
        latest: String(versionConfig.latest || versionConfig.minimum || "1.0"),
        message: String(versionConfig.message || "Please install the latest version of CUBE Launcher to continue.")
    };
}

function isLauncherMaintenanceEnabled() {
    const settings = launcherSettings.getSettings();
    return (settings.launcherMaintenance?.enabled ?? config.launcherMaintenance?.enabled) === true;
}

function parseVersionParts(version) {
    return String(version || "")
        .trim()
        .split(".")
        .map(part => Number.parseInt(part, 10))
        .map(part => Number.isFinite(part) ? part : 0);
}

function isVersionOlder(version, minimumVersion) {
    const left = parseVersionParts(version);
    const right = parseVersionParts(minimumVersion);
    const length = Math.max(left.length, right.length);

    for (let i = 0; i < length; i++) {
        const current = left[i] || 0;
        const minimum = right[i] || 0;
        if (current < minimum) return true;
        if (current > minimum) return false;
    }

    return false;
}

function validateLauncherUsername(username) {
    if (!username) return "The username was not entered.";
    if (username.length < USERNAME_MIN_LENGTH) return `Min ${USERNAME_MIN_LENGTH} characters.`;
    if (username.length > USERNAME_MAX_LENGTH) return `Max ${USERNAME_MAX_LENGTH} characters.`;
    if (!USERNAME_ALLOWED_PATTERN.test(username)) return "Use A-Z, 0-9, _, - or .";
    return "";
}

function isDuplicateUsernameError(err) {
    return err?.code === 11000 || err?.code === "11000" || err?.code === "23505";
}

function buildDiscordCallbackSuccessPage() {
    const backgroundImage = loadLauncherBackgroundDataUri();
    const backgroundCss = backgroundImage
        ? `linear-gradient(180deg, rgba(5, 5, 8, 0.34), rgba(5, 5, 8, 0.84)), url("${backgroundImage}") center/cover no-repeat`
        : "#050508";

    return `
        <!DOCTYPE html>
        <html lang="fr">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>CUBE Launcher</title>
            <style>
                :root {
                    color-scheme: dark;
                }

                * {
                    box-sizing: border-box;
                }

                body {
                    margin: 0;
                    min-height: 100vh;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 24px;
                    background: ${backgroundCss};
                    color: #fff;
                    font-family: Inter, Arial, sans-serif;
                }

                .panel {
                    width: min(430px, 100%);
                    text-align: center;
                    border: 1px solid rgba(255, 255, 255, 0.12);
                    border-radius: 18px;
                    padding: 34px 30px;
                    background: rgba(12, 12, 16, 0.70);
                    backdrop-filter: blur(12px);
                    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.35);
                }

                h1 {
                    margin: 0;
                    font-size: clamp(30px, 5vw, 38px);
                    line-height: 1.05;
                    font-weight: 800;
                }

                p {
                    margin: 12px 0 0;
                    color: rgba(255, 255, 255, 0.74);
                    font-size: 15px;
                    line-height: 1.5;
                }
            </style>
        </head>
        <body>
            <main class="panel">
                <h1>Login successful</h1>
                <p>You can return to CUBE Launcher.</p>
            </main>
            <script>
                setTimeout(() => window.close(), 1200);
            </script>
        </body>
        </html>
    `;
}

function getFiniteNumber(value) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : 0;
}

function sumStatsValue(stats, fieldName) {
    const buckets = ["solo", "duo", "trio", "squad", "ltm"];
    return buckets.reduce((total, bucketName) => {
        const bucket = stats?.[bucketName];
        return total + getFiniteNumber(bucket?.[fieldName]);
    }, 0);
}

function getPreferredLoadoutId(athenaProfile) {
    const lastAppliedLoadout = String(athenaProfile?.stats?.attributes?.last_applied_loadout || "").trim();
    if (lastAppliedLoadout && athenaProfile?.items?.[lastAppliedLoadout]) {
        return lastAppliedLoadout;
    }

    const activeLoadoutIndex = athenaProfile?.stats?.attributes?.active_loadout_index;
    if (activeLoadoutIndex !== undefined && activeLoadoutIndex !== null) {
        const indexedLoadoutId = `Fortnite${activeLoadoutIndex}-loadout`;
        if (athenaProfile?.items?.[indexedLoadoutId]) {
            return indexedLoadoutId;
        }
    }

    if (athenaProfile?.items?.sandbox_loadout) {
        return "sandbox_loadout";
    }

    return "";
}

function extractCurrentSkinTemplateId(profileDocument) {
    const athenaProfile = profileDocument?.profiles?.athena;
    if (!athenaProfile || typeof athenaProfile !== "object") {
        return "";
    }

    const preferredLoadoutId = getPreferredLoadoutId(athenaProfile);
    const preferredLoadout = preferredLoadoutId ? athenaProfile.items?.[preferredLoadoutId] : null;
    const characterFromLoadout = preferredLoadout?.attributes?.locker_slots_data?.slots?.Character?.items?.[0];
    if (characterFromLoadout) {
        return String(characterFromLoadout).trim();
    }

    const favoriteCharacter = athenaProfile?.stats?.attributes?.favorite_character;
    if (favoriteCharacter) {
        return String(favoriteCharacter).trim();
    }

    return "";
}

function getCosmeticIdFromTemplateId(templateId) {
    const normalizedTemplateId = String(templateId || "").trim();
    if (!normalizedTemplateId) {
        return "";
    }

    const [, cosmeticId = normalizedTemplateId] = normalizedTemplateId.split(":");
    return String(cosmeticId).trim();
}

function normalizeLeaderboardEntry(entry) {
    const kills = getFiniteNumber(entry.kills);
    const arenaPoints = getFiniteNumber(entry.arenaPoints);
    const playtimeMinutes = getFiniteNumber(entry.playtimeMinutes);

    return {
        accountId: String(entry.accountId || "").trim(),
        username: String(entry.username || "").trim() || "Unknown player",
        kills,
        arenaPoints,
        playtimeMinutes,
        currentSkinId: String(entry.currentSkinId || "").trim(),
        currentSkinName: String(entry.currentSkinName || "").trim(),
        currentSkinIconUrl: String(entry.currentSkinIconUrl || "").trim()
    };
}

function sortLeaderboardEntries(entries, metric) {
    const metricName = metric === "arenaPoints" || metric === "playtimeMinutes" ? metric : "kills";

    return [...entries]
        .sort((left, right) => {
            const metricDelta = getFiniteNumber(right[metricName]) - getFiniteNumber(left[metricName]);
            if (metricDelta !== 0) {
                return metricDelta;
            }

            const secondaryKillsDelta = getFiniteNumber(right.kills) - getFiniteNumber(left.kills);
            if (secondaryKillsDelta !== 0) {
                return secondaryKillsDelta;
            }

            const secondaryArenaDelta = getFiniteNumber(right.arenaPoints) - getFiniteNumber(left.arenaPoints);
            if (secondaryArenaDelta !== 0) {
                return secondaryArenaDelta;
            }

            const secondaryPlaytimeDelta = getFiniteNumber(right.playtimeMinutes) - getFiniteNumber(left.playtimeMinutes);
            if (secondaryPlaytimeDelta !== 0) {
                return secondaryPlaytimeDelta;
            }

            return left.username.localeCompare(right.username, "en", { sensitivity: "base" });
        })
        .map((entry, index) => ({
            ...entry,
            rank: index + 1
        }));
}

async function fetchCosmeticMetadata(cosmeticId) {
    const normalizedCosmeticId = String(cosmeticId || "").trim().toLowerCase();
    if (!normalizedCosmeticId) {
        return null;
    }

    const cachedEntry = cosmeticCache.get(normalizedCosmeticId);
    if (cachedEntry && cachedEntry.expiresAt > Date.now()) {
        return cachedEntry.data;
    }

    try {
        const response = await axios.get("https://fortnite-api.com/v2/cosmetics/br/search", {
            params: {
                language: "en",
                id: normalizedCosmeticId
            },
            timeout: 5000
        });

        const cosmetic = response?.data?.data;
        const data = cosmetic ? {
            id: String(cosmetic.id || normalizedCosmeticId),
            name: String(cosmetic.name || "").trim(),
            iconUrl: String(cosmetic.images?.smallIcon || cosmetic.images?.icon || cosmetic.images?.featured || "").trim()
        } : null;

        cosmeticCache.set(normalizedCosmeticId, {
            expiresAt: Date.now() + COSMETIC_CACHE_TTL_MS,
            data
        });

        return data;
    } catch (_error) {
        cosmeticCache.set(normalizedCosmeticId, {
            expiresAt: Date.now() + 5 * 60 * 1000,
            data: null
        });
        return null;
    }
}

async function hydrateCosmeticMetadata(entries) {
    const uniqueCosmeticIds = Array.from(
        new Set(entries.map((entry) => entry.currentSkinId).filter(Boolean))
    );

    const cosmeticEntries = await Promise.all(uniqueCosmeticIds.map(async (cosmeticId) => {
        const metadata = await fetchCosmeticMetadata(cosmeticId);
        return [cosmeticId, metadata];
    }));

    const cosmeticMap = new Map(cosmeticEntries);

    return entries.map((entry) => {
        const cosmetic = cosmeticMap.get(entry.currentSkinId) || null;
        return normalizeLeaderboardEntry({
            ...entry,
            currentSkinName: cosmetic?.name || entry.currentSkinName || entry.currentSkinId,
            currentSkinIconUrl: cosmetic?.iconUrl || entry.currentSkinIconUrl || ""
        });
    });
}

async function buildLauncherLeaderboardSnapshot() {
    if (leaderboardCache.payload && leaderboardCache.expiresAt > Date.now()) {
        return leaderboardCache.payload;
    }

    const [users, stats, arenas, profiles] = await Promise.all([
        User.find({ isServer: { $ne: true }, banned: { $ne: true }, username_lower: { $not: /hostaccount$|_host$/i }, email: { $not: /^hostaccount@/i }, discordUsername: { $not: /hostaccount$|_host$/i } }, { accountId: 1, username: 1 }).lean(),
        UserStats.find({}, { accountId: 1, solo: 1, duo: 1, trio: 1, squad: 1, ltm: 1 }).lean(),
        Arena.find({}, { accountId: 1, hype: 1 }).lean(),
        Profile.find({}, { accountId: 1, profiles: 1 }).lean()
    ]);

    const statsByAccountId = new Map(stats.map((entry) => [entry.accountId, entry]));
    const arenaByAccountId = new Map(arenas.map((entry) => [entry.accountId, entry]));
    const profileByAccountId = new Map(profiles.map((entry) => [entry.accountId, entry]));

    const rawEntries = users.map((user) => {
        const userStats = statsByAccountId.get(user.accountId) || null;
        const arenaStats = arenaByAccountId.get(user.accountId) || null;
        const profileDocument = profileByAccountId.get(user.accountId) || null;
        const currentSkinTemplateId = extractCurrentSkinTemplateId(profileDocument);

        return {
            accountId: user.accountId,
            username: user.username,
            kills: sumStatsValue(userStats, "kills"),
            arenaPoints: getFiniteNumber(arenaStats?.hype),
            playtimeMinutes: sumStatsValue(userStats, "minutesplayed"),
            currentSkinId: getCosmeticIdFromTemplateId(currentSkinTemplateId),
            currentSkinName: "",
            currentSkinIconUrl: ""
        };
    }).filter((entry) => entry.kills > 0 || entry.arenaPoints > 0 || entry.playtimeMinutes > 0 || entry.currentSkinId);

    const hydratedEntries = await hydrateCosmeticMetadata(rawEntries);
    const payload = {
        success: true,
        refreshedAt: new Date().toISOString(),
        totalPlayers: hydratedEntries.length,
        entries: hydratedEntries
    };

    leaderboardCache = {
        expiresAt: Date.now() + LEADERBOARD_CACHE_TTL_MS,
        payload
    };

    return payload;
}

app.get("/api/launcher/login", async (req, res) => {
    const { email, password } = req.query;

    if (!email) return res.status(400).send("The email was not entered.");
    if (!password) return res.status(400).send("The password was not entered.");

    try {
        const user = await User.findOne({ email });
        if (!user) return res.status(404).send("User not found.");

        const passwordMatch = await bcrypt.compare(password, user.password);

        if (passwordMatch) {
            const roleInfo = await getUserRoleInfoForLauncher(user);
            return res.status(200).json({
                username: user.username,
                discordUsername: user.discordUsername || "",
                accountId: user.accountId,
                avatarUrl: user.discordAvatar,
                roleName: roleInfo.name || user.discordRoleName || "",
                roleColor: roleInfo.color || user.discordRoleColor || 0,
                roles: Array.isArray(roleInfo.roles) ? roleInfo.roles : [],
                beta: launcherBeta.getBetaState(config)
            });
        }

        return res.status(400).send("Error!");
    } catch (err) {
        log.error("Launcher Api Error:", err);
        return res.status(500).send("Error encountered, look at the console");
    }
});

app.get("/api/launcher/version", (req, res) => {
    const currentVersion = String(req.query.current || "").trim();
    const versionConfig = getLauncherVersionConfig();
    const updateTargetVersion = isVersionOlder(versionConfig.latest, versionConfig.minimum)
        ? versionConfig.minimum
        : versionConfig.latest;
    const maintenance = isLauncherMaintenanceEnabled();

    return res.json({
        success: true,
        minimum: versionConfig.minimum,
        latest: versionConfig.latest,
        maintenance,
        updateRequired: !maintenance && currentVersion ? isVersionOlder(currentVersion, updateTargetVersion) : false,
        message: versionConfig.message
    });
});

app.get("/api/launcher/beta-status", (_req, res) => {
    return res.json({
        success: true,
        beta: launcherBeta.getBetaState(config)
    });
});

app.get("/api/launcher/discord/start", (_req, res) => {
    try {
        const url = discordLauncherAuth.buildAuthorizeUrl(config);
        const parsed = new URL(url);
        return res.json({
            success: true,
            url,
            state: parsed.searchParams.get("state")
        });
    } catch (err) {
        log.error("Launcher Discord OAuth start error:", err);
        return res.status(500).json({ success: false, error: "Unable to start Discord login." });
    }
});

app.get("/api/launcher/discord/callback", async (req, res) => {
    const { code, state } = req.query;
    if (!code) return res.status(400).send("Missing Discord OAuth code.");
    if (!discordLauncherAuth.consumeOAuthState(state)) {
        return res.status(400).send("Invalid Discord OAuth state.");
    }

    try {
        await discordLauncherAuth.handleCallback(config, code, state);
        return res.send(buildDiscordCallbackSuccessPage());
    } catch (err) {
        log.error("Launcher Discord OAuth callback error:", err);
        return res.status(500).send("Discord authentication failed.");
    }
});

app.get("/api/launcher/discord/poll/:state", (req, res) => {
    const sessionId = discordLauncherAuth.getSessionIdForState(req.params.state);
    if (!sessionId) {
        return res.json({ success: false, pending: true });
    }

    return res.json({ success: true, sessionId });
});

app.get("/api/launcher/discord/session/:sessionId", (req, res) => {
    const session = discordLauncherAuth.consumeLauncherSession(req.params.sessionId);
    if (!session) {
        return res.status(404).json({ success: false, error: "Invalid or expired session." });
    }

    return res.json({
        success: true,
        user: {
            ...session,
            beta: launcherBeta.getBetaState(config)
        }
    });
});

app.post("/api/launcher/launch-ticket", async (req, res) => {
    const launchSessionToken = getLaunchSessionToken(req);
    if (launchSessionToken) {
        try {
            const sessionTicket = await discordLauncherAuth.createLaunchTicketFromSessionToken(launchSessionToken, config);
            if (sessionTicket?.ticket && sessionTicket?.user) {
                return res.json({
                    success: true,
                    accountId: sessionTicket.user.accountId,
                    username: sessionTicket.user.username,
                    launchEmail: sessionTicket.ticket.login,
                    launchPassword: sessionTicket.ticket.password,
                    launch_ticket: sessionTicket.ticket.login,
                    launchTicket: sessionTicket.ticket.login,
                    launchSessionToken: sessionTicket.launchSessionToken || sessionTicket.ticket.launchSessionToken
                });
            }
        } catch (err) {
            log.error("Launcher session ticket error:", err);
            return res.status(500).json({ success: false, error: "Unable to create launcher ticket." });
        }
    }

    if (req.headers["x-launcher-secret"] !== LAUNCHER_SECRET) {
        return res.status(401).json({ success: false, error: "Invalid launcher secret." });
    }

    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "").trim();
    const accountId = String(req.body?.accountId || "").trim();
    if (accountId && (!email || !password)) {
        try {
            const user = await User.findOne({ accountId });
            if (!user) {
                return res.status(401).json({ success: false, error: "Invalid launcher session." });
            }

            const ticket = await discordLauncherAuth.createLaunchTicket(user, config);
            return res.json({
                success: true,
                accountId: user.accountId,
                username: user.username,
                launchEmail: ticket.login,
                launchPassword: ticket.password,
                launch_ticket: ticket.login,
                launchTicket: ticket.login,
                launchSessionToken: ticket.launchSessionToken
            });
        } catch (err) {
            log.error("Launcher account ticket error:", err);
            return res.status(500).json({ success: false, error: "Unable to create launcher ticket." });
        }
    }

    if (!email || !password) {
        return res.status(400).json({ success: false, error: "Missing launcher credentials." });
    }

    try {
        const user = await User.findOne({ email });
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ success: false, error: "Invalid launcher credentials." });
        }

        const roleInfo = await getUserRoleInfoForLauncher(user);
        const betaAccess = launcherBeta.ensureBetaAccess(config, roleInfo.roles);
        if (!betaAccess.allowed) {
            return res.status(betaAccess.statusCode || 403).json({
                success: false,
                error: betaAccess.error,
                beta: betaAccess.beta
            });
        }

        const ticket = await discordLauncherAuth.createLaunchTicket(user, config);
        return res.json({
            success: true,
            accountId: user.accountId,
            username: user.username,
            launchEmail: ticket.login,
            launchPassword: ticket.password,
            launch_ticket: ticket.login,
            launchTicket: ticket.login,
            launchSessionToken: ticket.launchSessionToken,
            beta: betaAccess.beta
        });
    } catch (err) {
        log.error("Launcher ticket error:", err);
        return res.status(500).json({ success: false, error: "Unable to create launcher ticket." });
    }
});

app.get("/api/launcher/online-count", (_req, res) => {
    return res.json({
        success: true,
        online: Array.isArray(global.Clients) ? global.Clients.length : 0
    });
});

app.get("/api/launcher/leaderboard", async (req, res) => {
    const metric = String(req.query.metric || "kills").trim();
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(Math.floor(requestedLimit), LEADERBOARD_LIMIT_MAX)
        : 50;

    try {
        const snapshot = await buildLauncherLeaderboardSnapshot();
        const sortedEntries = sortLeaderboardEntries(snapshot.entries, metric).slice(0, limit);

        return res.json({
            success: true,
            metric: metric === "arenaPoints" || metric === "playtimeMinutes" ? metric : "kills",
            totalPlayers: snapshot.totalPlayers,
            refreshedAt: snapshot.refreshedAt,
            entries: sortedEntries
        });
    } catch (err) {
        log.error("Launcher leaderboard error:", err);
        return res.status(500).json({ success: false, error: "Unable to load launcher leaderboard." });
    }
});

app.get("/api/launcher/friends", async (req, res) => {
    const user = await getLauncherSessionUser(req);
    if (!user) return res.status(401).json({ success: false, error: "Invalid launcher session." });

    try {
        const payload = await buildLauncherFriendsPayload(user.accountId);
        return res.json({ success: true, ...payload });
    } catch (err) {
        log.error("Launcher friends error:", err);
        return res.status(500).json({ success: false, error: "Unable to load launcher friends." });
    }
});

app.get("/api/launcher/friends/summary", async (req, res) => {
    const user = await getLauncherSessionUser(req);
    if (!user) return res.status(401).json({ success: false, error: "Invalid launcher session." });

    try {
        const payload = await buildLauncherFriendsPayload(user.accountId);
        return res.json({ success: true, ...payload });
    } catch (err) {
        log.error("Launcher friends summary error:", err);
        return res.status(500).json({ success: false, error: "Unable to load launcher friends." });
    }
});

app.post("/api/launcher/friends/:friendId", async (req, res) => {
    const user = await getLauncherSessionUser(req);
    if (!user) return res.status(401).json({ success: false, error: "Invalid launcher session." });

    const friendId = String(req.params.friendId || "").trim();
    if (!friendId || friendId === user.accountId) {
        return res.status(400).json({ success: false, error: "Invalid friend account." });
    }

    const [sender, receiver] = await Promise.all([
        Friends.findOne({ accountId: user.accountId }).lean(),
        Friends.findOne({ accountId: friendId }).lean()
    ]);
    if (!sender || !receiver) return res.status(404).json({ success: false, error: "Friend account not found." });

    const senderList = normalizeFriendsList(sender);
    const accepted = senderList.accepted.some(entry => getFriendAccountId(entry) === friendId);
    const incoming = senderList.incoming.some(entry => getFriendAccountId(entry) === friendId);

    if (!accepted) {
        const ok = incoming
            ? await friendManager.acceptFriendReq(user.accountId, friendId)
            : await friendManager.sendFriendReq(user.accountId, friendId);
        if (!ok) return res.status(403).json({ success: false, error: "Unable to update friend request." });
    }

    return res.json({ success: true });
});

app.delete("/api/launcher/friends/:friendId", async (req, res) => {
    const user = await getLauncherSessionUser(req);
    if (!user) return res.status(401).json({ success: false, error: "Invalid launcher session." });

    const friendId = String(req.params.friendId || "").trim();
    if (!friendId || friendId === user.accountId) {
        return res.status(400).json({ success: false, error: "Invalid friend account." });
    }

    const ok = await friendManager.deleteFriend(user.accountId, friendId);
    if (!ok) return res.status(403).json({ success: false, error: "Unable to remove friend." });

    return res.json({ success: true });
});

app.post("/api/launcher/change-username", async (req, res) => {
    const newUsername = String(req.body?.username || "").trim();
    const usernameValidationError = validateLauncherUsername(newUsername);
    if (usernameValidationError) {
        return res.status(400).json({ success: false, error: usernameValidationError });
    }

    let user = await getLauncherSessionUser(req);
    if (!user && req.headers["x-launcher-secret"] === LAUNCHER_SECRET && req.body?.accountId) {
        user = await User.findOne({ accountId: req.body.accountId });
    }

    if (!user) {
        return res.status(401).json({ success: false, error: "Authentication failed." });
    }

    try {
        const Badwords = require("bad-words");
        const badwords = new Badwords();
        if (badwords.isProfane(newUsername)) {
            return res.status(400).json({ success: false, error: "Username must not contain inappropriate language." });
        }
    } catch (_err) {}

    const existingUser = await User.findOne({ username_lower: newUsername.toLowerCase() });
    if (existingUser && existingUser.accountId !== user.accountId) {
        return res.status(400).json({ success: false, error: "Username already exists." });
    }

    try {
        await user.updateOne({
            $set: {
                username: newUsername,
                username_lower: newUsername.toLowerCase(),
                lastUsernameChange: new Date()
            }
        });
    } catch (err) {
        if (isDuplicateUsernameError(err)) {
            return res.status(400).json({ success: false, error: "Username already exists." });
        }
        log.error("Launcher change username error:", err);
        return res.status(500).json({ success: false, error: "Unable to change username." });
    }

    return res.json({ success: true, username: newUsername });
});

module.exports = app;
