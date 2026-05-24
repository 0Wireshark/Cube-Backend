const { createModel } = require("../database/pgModel.js");

module.exports = createModel({
    table: "users",
    primaryKey: "accountId",
    columns: {
        _id: { column: "id", type: "text" },
        created: { column: "created", type: "timestamptz" },
        banned: { column: "banned", type: "boolean" },
        bannedUntil: { column: "banned_until", type: "timestamptz" },
        banReason: { column: "ban_reason", type: "text" },
        discordId: { column: "discord_id", type: "text" },
        discordUsername: { column: "discord_username", type: "text" },
        discordAvatar: { column: "discord_avatar", type: "text" },
        discordRoleName: { column: "discord_role_name", type: "text" },
        discordRoleColor: { column: "discord_role_color", type: "number" },
        accountId: { column: "account_id", type: "text" },
        username: { column: "username", type: "text" },
        username_lower: { column: "username_lower", type: "text" },
        email: { column: "email", type: "text" },
        password: { column: "password", type: "text" },
        matchmakingId: { column: "matchmaking_id", type: "text" },
        isServer: { column: "is_server", type: "boolean" },
        currentSACCode: { column: "current_sac_code", type: "text" },
        lastUsernameChange: { column: "last_username_change", type: "timestamptz" }
    },
    defaults: {
        created: () => new Date(),
        banned: false,
        bannedUntil: null,
        banReason: null,
        discordId: null,
        discordUsername: "",
        discordAvatar: null,
        discordRoleName: "",
        discordRoleColor: 0,
        isServer: false,
        currentSACCode: null,
        lastUsernameChange: null
    }
});
