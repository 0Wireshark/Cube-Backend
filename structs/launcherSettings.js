const fs = require("fs");
const path = require("path");

const SETTINGS_PATH = path.join(__dirname, "..", "Saved", "launcher-settings.json");

function loadSettings() {
    try {
        return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
    } catch (_err) {
        return {};
    }
}

function saveSettings(settings) {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
}

function getSettings() {
    return loadSettings();
}

function setLauncherVersion(version) {
    const settings = loadSettings();
    settings.launcherVersion = {
        ...(settings.launcherVersion || {}),
        minimum: version,
        latest: version
    };
    saveSettings(settings);
    return settings.launcherVersion;
}

function setMaintenance(enabled) {
    const settings = loadSettings();
    settings.launcherMaintenance = {
        ...(settings.launcherMaintenance || {}),
        enabled
    };
    saveSettings(settings);
    return settings.launcherMaintenance;
}

module.exports = {
    getSettings,
    setLauncherVersion,
    setMaintenance
};
