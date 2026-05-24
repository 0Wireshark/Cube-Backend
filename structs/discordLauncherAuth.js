const axios = require("axios");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const functions = require("./functions.js");
const User = require("../model/user.js");
const LaunchTicket = require("../model/launchtickets.js");
const log = require("./log.js");

const DISCORD_API_URL = "https://discord.com/api/v10";
const pendingStates = new Map();
const pendingSessions = new Map();
const pendingStatesToSessions = new Map();
const pendingLaunchAuthorizations = new Map();
const LAUNCH_TICKET_PREFIX = "launcher-ticket-";
const LAUNCH_TICKET_DOMAIN = "@cube.local";

function getLaunchOnlyConfig(config) {
  return config?.launchOnly && typeof config.launchOnly === "object"
    ? config.launchOnly
    : {};
}

function getLaunchTicketTtlMs(config) {
  const ttlSeconds = Number(getLaunchOnlyConfig(config).ticketTtlSeconds);
  return Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds * 1000 : 2 * 60 * 1000;
}

function getLaunchSessionTtlMs(config) {
  const ttlSeconds = Number(getLaunchOnlyConfig(config).sessionTtlSeconds);
  return Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds * 1000 : 30 * 24 * 60 * 60 * 1000;
}

function getLaunchSessionSigningSecret(config = {}) {
  return String(
    getLaunchOnlyConfig(config).launcherSecret ||
    config.jwtSecret ||
    process.env.LAUNCHER_SECRET ||
    process.env.JWT_SECRET ||
    ""
  );
}

function base64UrlEncode(value) {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function signLaunchSessionPayload(payload, config = {}) {
  const secret = getLaunchSessionSigningSecret(config);
  if (!secret) return "";

  return crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createLaunchSessionToken(accountId, expiresAt, config = {}) {
  const payload = base64UrlEncode(JSON.stringify({
    accountId,
    expiresAt
  }));
  const signature = signLaunchSessionPayload(payload, config);
  if (!signature) return crypto.randomBytes(32).toString("hex");
  return `v1.${payload}.${signature}`;
}

function verifySignedLaunchSessionToken(sessionToken, config = {}) {
  const parts = String(sessionToken || "").split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;

  const [, payload, signature] = parts;
  const expectedSignature = signLaunchSessionPayload(payload, config);
  if (!expectedSignature || !timingSafeEqualString(signature, expectedSignature)) return null;

  try {
    const data = JSON.parse(base64UrlDecode(payload));
    const accountId = String(data.accountId || "").trim();
    const expiresAt = Number(data.expiresAt);
    if (!accountId || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
    return { accountId, expiresAt };
  } catch {
    return null;
  }
}

function isDisplayableGuildRole(role) {
  const name = String(role?.name || "").trim();
  if (!name || name === "@everyone") return false;
  if (/^[.\-_•|:;~`^=+*\\/()\[\]{}<>]+$/u.test(name)) return false;
  if (!/[\p{L}\p{N}]/u.test(name)) return false;
  return true;
}

function mapRolePayload(role) {
  return {
    id: String(role.id || ""),
    name: String(role.name || "").trim(),
    color: Number(role.color) || 0,
    position: Number(role.position) || 0
  };
}

function buildRoleInfoFromRoles(roles) {
  const filteredRoles = roles
    .filter(isDisplayableGuildRole)
    .map(mapRolePayload)
    .sort((a, b) => b.position - a.position);

  const topRole = filteredRoles[0];
  return {
    name: topRole ? topRole.name : "",
    color: topRole ? topRole.color : 0,
    roles: filteredRoles
  };
}

function getDiscordOAuthConfig(config) {
  const redirectUri = (config.LauncherOAuth && config.LauncherOAuth.redirectUri)
    ? config.LauncherOAuth.redirectUri.replace("${port}", config.port)
    : `http://localhost:${config.port}/api/launcher/discord/callback`;

  return {
    clientId: config.LauncherOAuth?.clientId || config.Website.clientId,
    clientSecret: config.LauncherOAuth?.clientSecret || config.Website.clientSecret,
    redirectUri,
    guildId: config.discord.guildId || "",
    botToken: config.discord.bot_token || ""
  };
}

function buildAuthorizeUrl(config) {
  const oauth = getDiscordOAuthConfig(config);
  const state = crypto.randomBytes(24).toString("hex");
  pendingStates.set(state, Date.now() + 5 * 60 * 1000);

  const params = new URLSearchParams({
    client_id: oauth.clientId,
    redirect_uri: oauth.redirectUri,
    response_type: "code",
    scope: "identify guilds.join",
    state
  });

  return `${DISCORD_API_URL}/oauth2/authorize?${params.toString()}`;
}

function consumeOAuthState(state) {
  const expiresAt = pendingStates.get(state);
  if (!expiresAt) return false;

  pendingStates.delete(state);
  return expiresAt >= Date.now();
}

async function exchangeCodeForToken(config, code) {
  const oauth = getDiscordOAuthConfig(config);
  const response = await axios.post(`${DISCORD_API_URL}/oauth2/token`, new URLSearchParams({
    client_id: oauth.clientId,
    client_secret: oauth.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: oauth.redirectUri
  }), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" }
  });

  return response.data;
}

async function fetchDiscordUser(accessToken) {
  const response = await axios.get(`${DISCORD_API_URL}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  return response.data;
}

async function addUserToGuild(config, discordUserId, accessToken) {
  const oauth = getDiscordOAuthConfig(config);
  if (!oauth.guildId || !oauth.botToken) return null;

  try {
    const response = await axios.put(
      `${DISCORD_API_URL}/guilds/${oauth.guildId}/members/${discordUserId}`,
      { access_token: accessToken },
      { headers: { Authorization: `Bot ${oauth.botToken}` } }
    );

    return response.data || null;
  } catch (error) {
    log.error("Discord guild join failed:", error?.response?.data || error?.message || error);
    return null;
  }
}

async function fetchGuildRoleInfoFromBot(config, discordUserId) {
  const oauth = getDiscordOAuthConfig(config);
  const client = global.discordClient;
  if (!oauth.guildId || !client || !global.botConnected) {
    return null;
  }

  try {
    const guild = client.guilds.cache.get(oauth.guildId) || await client.guilds.fetch(oauth.guildId);
    if (!guild) return null;

    const member = guild.members.cache.get(discordUserId) || await guild.members.fetch(discordUserId);
    if (!member) {
      return { name: "", color: 0, roles: [] };
    }

    return buildRoleInfoFromRoles(Array.from(member.roles.cache.values()));
  } catch (error) {
    log.error("Discord cached role lookup failed:", error?.message || error);
    return null;
  }
}

async function fetchGuildRoleInfoFromRest(config, discordUserId) {
  const oauth = getDiscordOAuthConfig(config);
  if (!oauth.guildId || !oauth.botToken) {
    return { name: "", color: 0, roles: [] };
  }

  try {
    const [memberResponse, rolesResponse] = await Promise.all([
      axios.get(`${DISCORD_API_URL}/guilds/${oauth.guildId}/members/${discordUserId}`, {
        headers: { Authorization: `Bot ${oauth.botToken}` }
      }),
      axios.get(`${DISCORD_API_URL}/guilds/${oauth.guildId}/roles`, {
        headers: { Authorization: `Bot ${oauth.botToken}` }
      })
    ]);

    const roleIds = new Set(memberResponse.data.roles || []);
    const roles = (rolesResponse.data || []).filter(role => roleIds.has(role.id));
    return buildRoleInfoFromRoles(roles);
  } catch (error) {
    log.error("Discord role lookup failed:", error?.response?.data || error?.message || error);
    return { name: "", color: 0, roles: [] };
  }
}

async function fetchGuildRoleInfo(config, discordUserId) {
  const cachedRoleInfo = await fetchGuildRoleInfoFromBot(config, discordUserId);
  if (cachedRoleInfo) {
    return cachedRoleInfo;
  }

  return fetchGuildRoleInfoFromRest(config, discordUserId);
}

async function refreshGuildRoleInfoForUser(config, user) {
  if (!user?.discordId) {
    return { name: "", color: 0, roles: [] };
  }

  const roleInfo = await fetchGuildRoleInfo(config, user.discordId);
  if (typeof user.save !== "function") {
    return roleInfo;
  }

  const nextRoleName = roleInfo.name || "";
  const nextRoleColor = roleInfo.color || 0;
  if (user.discordRoleName !== nextRoleName || user.discordRoleColor !== nextRoleColor) {
    user.discordRoleName = nextRoleName;
    user.discordRoleColor = nextRoleColor;
    await user.save();
  }

  return roleInfo;
}

function getDiscordAvatarUrl(user) {
  if (!user.avatar) {
    const defaultIndex = Number(BigInt(user.id) >> 22n) % 6;
    return `https://cdn.discordapp.com/embed/avatars/${defaultIndex}.png`;
  }

  const extension = user.avatar.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${extension}?size=128`;
}

function normalizeUsername(value) {
  return String(value || "CUBE_Player")
    .replace(/[^\w .-]/g, "")
    .trim()
    .slice(0, 20) || "CUBE_Player";
}

function getPreferredDiscordAccountUsername(discordUser) {
  return normalizeUsername(discordUser?.username || "CUBE_Player");
}

async function getAvailableUsername(baseUsername, discordId, currentAccountId = "") {
  const base = normalizeUsername(baseUsername);
  const existingDiscordUser = await User.findOne({ discordId });
  if (existingDiscordUser && (!currentAccountId || existingDiscordUser.accountId !== currentAccountId)) {
    return existingDiscordUser.username;
  }

  let candidate = base;
  let suffix = 1;

  while (true) {
    const conflictingUser = await User.findOne({ username_lower: candidate.toLowerCase() }, { accountId: 1, username: 1 }).lean();
    if (!conflictingUser || conflictingUser.accountId === currentAccountId) {
      return candidate;
    }

    suffix += 1;
    const suffixText = String(suffix);
    candidate = `${base.slice(0, Math.max(3, 20 - suffixText.length))}${suffixText}`;
  }
}

async function findOrCreateLauncherUser(discordUser, roleInfo) {
  const discordId = discordUser.id;
  const discordUsername = String(discordUser.username || "").trim();
  const avatarUrl = getDiscordAvatarUrl(discordUser);
  const preferredUsername = getPreferredDiscordAccountUsername(discordUser);
  const username = await getAvailableUsername(preferredUsername, discordId);
  const email = `discord-${discordId}@cube.local`;
  const launcherPassword = crypto.randomBytes(24).toString("hex");

  let user = await User.findOne({ discordId });
  if (!user) {
    const result = await functions.registerUser(discordId, username, email, launcherPassword);
    if (result.status !== 200) {
      throw new Error(result.message || "Unable to create account.");
    }

    user = await User.findOne({ discordId });
  }

  const normalizedGlobalName = normalizeUsername(discordUser.global_name || "");
  const normalizedCurrentUsername = normalizeUsername(user.username || "");
  const shouldReplaceLegacyDisplayName = Boolean(
    normalizedGlobalName
    && normalizedCurrentUsername
    && normalizedCurrentUsername.toLowerCase() === normalizedGlobalName.toLowerCase()
    && normalizedCurrentUsername.toLowerCase() !== preferredUsername.toLowerCase()
    && String(user.email || "").trim().toLowerCase() === email.toLowerCase()
  );

  user.discordUsername = discordUsername;
  user.discordAvatar = avatarUrl;
  user.discordRoleName = roleInfo.name || "";
  user.discordRoleColor = roleInfo.color || 0;
  if (!user.username || shouldReplaceLegacyDisplayName) {
    user.username = await getAvailableUsername(preferredUsername, discordId, user.accountId);
  }
  user.username_lower = user.username.toLowerCase();
  user.email = user.email || email;
  user.password = await bcrypt.hash(launcherPassword, 10);
  await user.save();

  return {
    user,
    launcherCredentials: {
      email: user.email,
      password: launcherPassword
    }
  };
}

function createLauncherSession(user, roleInfo = {}, launcherCredentials = {}, config = {}) {
  const sessionId = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + getLaunchSessionTtlMs(config);
  const launchSessionToken = createLaunchSessionToken(user.accountId, expiresAt, config);
  const launchEmail = String(launcherCredentials.email || user.email || "").trim();
  const launchPassword = String(launcherCredentials.password || "").trim();

  if (!launchEmail || !launchPassword) {
    throw new Error("Launcher credentials were not generated.");
  }

  const payload = {
    accountId: user.accountId,
    username: user.username,
    discordUsername: user.discordUsername || "",
    discordId: user.discordId,
    avatarUrl: user.discordAvatar,
    roleName: roleInfo.name || user.discordRoleName || "",
    roleColor: roleInfo.color || user.discordRoleColor || 0,
    roles: Array.isArray(roleInfo.roles) ? roleInfo.roles : [],
    launchEmail,
    launchPassword,
    launchSessionToken,
    expiresAt
  };

  pendingLaunchAuthorizations.set(launchSessionToken, {
    accountId: user.accountId,
    expiresAt: payload.expiresAt
  });
  pendingSessions.set(sessionId, payload);
  return sessionId;
}

function consumeLauncherSession(sessionId) {
  const payload = pendingSessions.get(sessionId);
  if (!payload) return null;

  pendingSessions.delete(sessionId);
  for (const [state, session] of pendingStatesToSessions.entries()) {
    if (session.sessionId === sessionId) {
      pendingStatesToSessions.delete(state);
      break;
    }
  }

  if (payload.expiresAt < Date.now()) return null;
  return payload;
}

function attachSessionToState(state, sessionId, config = {}) {
  if (!state || !sessionId) return;
  pendingStatesToSessions.set(state, {
    sessionId,
    expiresAt: Date.now() + getLaunchSessionTtlMs(config)
  });
}

function getSessionIdForState(state) {
  const payload = pendingStatesToSessions.get(state);
  if (!payload) return null;

  if (payload.expiresAt < Date.now()) {
    pendingStatesToSessions.delete(state);
    return null;
  }

  return payload.sessionId;
}

function consumeSessionIdForState(state) {
  const sessionId = getSessionIdForState(state);
  if (sessionId) pendingStatesToSessions.delete(state);
  return sessionId;
}

async function createLaunchTicket(user, config = {}) {
  if (!user?.accountId) {
    throw new Error("Invalid launcher user.");
  }

  const sessionExpiresAt = Date.now() + getLaunchSessionTtlMs(config);
  const ticketId = crypto.randomBytes(24).toString("hex");
  const ticketPassword = crypto.randomBytes(32).toString("hex");
  const login = `${LAUNCH_TICKET_PREFIX}${ticketId}${LAUNCH_TICKET_DOMAIN}`;
  const ttlMs = getLaunchTicketTtlMs(config);

  // Purge any existing tickets for this account before creating a new one
  await LaunchTicket.deleteMany({ accountId: user.accountId }).catch(() => {});

  await LaunchTicket.create({
    login,
    password: ticketPassword,
    accountId: user.accountId,
    expiresAt: new Date(Date.now() + ttlMs)
  });

  return {
    login,
    password: ticketPassword,
    launchSessionToken: createLaunchSessionToken(user.accountId, sessionExpiresAt, config)
  };
}

async function createLaunchTicketFromSessionToken(sessionToken, config = {}) {
  const authorization = getLaunchAuthorization(sessionToken);
  if (!authorization) return null;

  const user = await User.findOne({ accountId: authorization.accountId });
  if (!user) return null;

  const ticket = await createLaunchTicket(user, config);
  const expiresAt = Date.now() + getLaunchSessionTtlMs(config);
  const launchSessionToken = createLaunchSessionToken(user.accountId, expiresAt, config);
  pendingLaunchAuthorizations.set(launchSessionToken, {
    accountId: user.accountId,
    expiresAt
  });

  return { ticket, user, launchSessionToken };
}

async function consumeLaunchTicket(login, password) {
  const normalizedLogin = String(login || "").trim().toLowerCase();
  const normalizedPassword = String(password || "").trim();

  if (!normalizedLogin.startsWith(LAUNCH_TICKET_PREFIX) || !normalizedLogin.endsWith(LAUNCH_TICKET_DOMAIN)) {
    return null;
  }

  const ticket = await LaunchTicket.findOneAndDelete({ login: normalizedLogin }).lean();

  if (!ticket) return null;
  if (new Date(ticket.expiresAt) < new Date()) return null;
  if (ticket.password !== normalizedPassword) return null;

  return User.findOne({ accountId: ticket.accountId }).lean();
}

function getLaunchAuthorization(sessionToken) {
  const normalizedToken = String(sessionToken || "").trim();
  if (!normalizedToken) return null;

  const signedAuthorization = verifySignedLaunchSessionToken(normalizedToken, require("../Config/config.json"));
  if (signedAuthorization) return signedAuthorization;

  const authorization = pendingLaunchAuthorizations.get(normalizedToken);
  if (!authorization) return null;

  if (authorization.expiresAt < Date.now()) {
    pendingLaunchAuthorizations.delete(normalizedToken);
    return null;
  }

  return authorization;
}

async function handleCallback(config, code, state) {
  const tokenData = await exchangeCodeForToken(config, code);
  const discordUser = await fetchDiscordUser(tokenData.access_token);
  await addUserToGuild(config, discordUser.id, tokenData.access_token);
  const roleInfo = await fetchGuildRoleInfo(config, discordUser.id);
  const { user, launcherCredentials } = await findOrCreateLauncherUser(discordUser, roleInfo);
  const sessionId = createLauncherSession(user, roleInfo, launcherCredentials, config);
  attachSessionToState(state, sessionId, config);

  return { sessionId, user };
}

module.exports = {
  buildAuthorizeUrl,
  consumeOAuthState,
  consumeSessionIdForState,
  getSessionIdForState,
  consumeLauncherSession,
  createLaunchTicket,
  createLaunchTicketFromSessionToken,
  consumeLaunchTicket,
  handleCallback,
  refreshGuildRoleInfoForUser,
  getLaunchAuthorization
};
