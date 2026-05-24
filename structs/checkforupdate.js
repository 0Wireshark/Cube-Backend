const log = require("../structs/log.js");
const fetch = require("node-fetch");
const packageJson = require("../package.json");

function getUpdatePackageUrl() {
    const repositoryUrl = String(packageJson.repository?.url || "").trim();
    const normalizedUrl = repositoryUrl
        .replace(/^git\+/, "")
        .replace(/\.git$/i, "")
        .replace(/^git@github\.com:/i, "https://github.com/");

    if (!normalizedUrl || !normalizedUrl.includes("github.com/")) {
        return "";
    }

    try {
        const parsed = new URL(normalizedUrl);
        const pathname = parsed.pathname.replace(/^\/+|\/+$/g, "");
        if (!pathname) {
            return "";
        }

        return `https://raw.githubusercontent.com/${pathname}/refs/heads/main/package.json`;
    } catch (_error) {
        return "";
    }
}

class CheckForUpdate {
    static async checkForUpdate(currentVersion) {
        try {
            const updatePackageUrl = getUpdatePackageUrl();
            if (!updatePackageUrl) {
                return false;
            }

            const response = await fetch(updatePackageUrl);
            if (!response.ok) {
                if (response.status !== 404) {
                    log.error(`Failed to fetch package.json. Status: ${response.status}`);
                }
                return false;
            }

            const packageJson = await response.json();
            const latestVersion = packageJson.version;

            if (isNewerVersion(latestVersion, currentVersion)) {
                log.checkforupdate(`A new version of the Backend has been released! ${currentVersion} -> ${latestVersion}, Download it from the GitHub repo.`);
                return true;
            } else {

            }

            return false;
        } catch (error) {
            log.error(`Error while checking for updates: ${error.message}`);
            return false;
        }
    }
}

function isNewerVersion(latest, current) {
    const latestParts = latest.split('.').map(Number);
    const currentParts = current.split('.').map(Number);

    for (let i = 0; i < latestParts.length; i++) {
        if (latestParts[i] > (currentParts[i] || 0)) {
            return true;
        } else if (latestParts[i] < (currentParts[i] || 0)) {
            return false;
        }
    }

    return false;
}

module.exports = CheckForUpdate;
