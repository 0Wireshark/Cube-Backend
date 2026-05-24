const launcherSettings = require("../../../structs/launcherSettings.js");

const ALLOWED_USER_IDS = new Set(["1481759966988599387", "1416023731490521149"]);

module.exports = {
    executePrefix: async (message, enabled) => {
        await message.delete().catch(() => {});

        if (!ALLOWED_USER_IDS.has(message.author.id)) {
            return;
        }

        try {
            launcherSettings.setMaintenance(enabled);
        } catch (err) {
            console.error(err);
        }
    }
};
