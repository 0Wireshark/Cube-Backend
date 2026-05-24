const fs = require("fs");
const path = require("path");

const defaultProfilesDir = path.join(__dirname, "..", "Config", "DefaultProfiles");
const defaultProfileTemplates = fs.readdirSync(defaultProfilesDir).map((fileName) => {
    return require(path.join(defaultProfilesDir, fileName));
});

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function createProfiles(accountId) {
    let profiles = {};
    const now = new Date().toISOString();

    defaultProfileTemplates.forEach((template) => {
        const profile = clone(template);

        profile.accountId = accountId;
        profile.created = now;
        profile.updated = now;

        profiles[profile.profileId] = profile;
    });

    return profiles;
}

async function validateProfile(profileId, profiles) {
    try {
        let profile = profiles.profiles[profileId];

        if (!profile || !profileId) throw new Error("Invalid profile/profileId");
    } catch {
        return false;
    }

    return true;
}

module.exports = {
    createProfiles,
    validateProfile
}
