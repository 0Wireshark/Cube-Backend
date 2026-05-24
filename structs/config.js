const fs = require("fs");
const path = require("path");

let cachedConfig = null;

/**
 * Get cached configuration
 * Reads config.json only once and caches it in memory
 * This prevents blocking file reads on every request
 */
function getConfig() {
    if (!cachedConfig) {
        const configPath = path.join(__dirname, "..", "Config", "config.json");
        cachedConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
        cachedConfig.postgres = {
            ...(cachedConfig.postgres || {}),
            connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL || cachedConfig.postgres?.connectionString,
            host: process.env.PGHOST || cachedConfig.postgres?.host,
            port: process.env.PGPORT ? Number(process.env.PGPORT) : cachedConfig.postgres?.port,
            database: process.env.PGDATABASE || cachedConfig.postgres?.database,
            user: process.env.PGUSER || cachedConfig.postgres?.user,
            password: process.env.PGPASSWORD || cachedConfig.postgres?.password,
            ssl: process.env.PGSSL !== undefined ? ["1", "true", "yes", "on"].includes(process.env.PGSSL.toLowerCase()) : cachedConfig.postgres?.ssl,
            autoMigrate: process.env.PG_AUTO_MIGRATE !== undefined ? process.env.PG_AUTO_MIGRATE !== "false" : cachedConfig.postgres?.autoMigrate
        };
    }
    return cachedConfig;
}

/**
 * Reload configuration from disk
 * Use this when config.json is modified
 */
function reloadConfig() {
    cachedConfig = null;
    return getConfig();
}

module.exports = getConfig();
module.exports.getConfig = getConfig;
module.exports.reloadConfig = reloadConfig;
