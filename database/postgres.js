const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { PGlite } = require("@electric-sql/pglite");

let pool = null;
let embeddedDb = null;
let connected = false;
let backend = "";

function parseBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value === "boolean") return value;
    return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function buildPoolConfig(config = {}) {
    const connectionString =
        process.env.DATABASE_URL ||
        process.env.POSTGRES_URL ||
        config.connectionString ||
        config.databaseUrl;

    const ssl = parseBoolean(process.env.PGSSL, Boolean(config.ssl))
        ? { rejectUnauthorized: parseBoolean(process.env.PGSSL_REJECT_UNAUTHORIZED, false) }
        : false;

    if (connectionString) {
        return {
            connectionString,
            ssl,
            max: Number(process.env.PGPOOL_MAX || config.poolMax || 10),
            idleTimeoutMillis: Number(process.env.PGIDLE_TIMEOUT_MS || config.idleTimeoutMs || 30000)
        };
    }

    return {
        host: process.env.PGHOST || config.host || "127.0.0.1",
        port: Number(process.env.PGPORT || config.port || 5432),
        database: process.env.PGDATABASE || config.database || "CUBE",
        user: process.env.PGUSER || config.user || "postgres",
        password: process.env.PGPASSWORD || config.password || "postgres",
        ssl,
        max: Number(process.env.PGPOOL_MAX || config.poolMax || 10),
        idleTimeoutMillis: Number(process.env.PGIDLE_TIMEOUT_MS || config.idleTimeoutMs || 30000)
    };
}

async function applySchema(client) {
    const schemaPath = path.join(__dirname, "schema.sql");
    const schema = fs.readFileSync(schemaPath, "utf8");
    for (const statement of splitSqlStatements(schema)) {
        await client.query(statement);
    }
}

function splitSqlStatements(sql) {
    return String(sql || "")
        .split(/;\s*(?:\r?\n|$)/)
        .map((statement) => statement.trim())
        .filter(Boolean);
}

function shouldUseEmbeddedFallback(config, error) {
    if (config.embedded === true || process.env.PG_EMBEDDED === "true") return true;
    if (config.embeddedFallback === false || process.env.PG_EMBEDDED_FALLBACK === "false") return false;

    const code = String(error?.code || "");
    return ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EHOSTUNREACH"].includes(code);
}

function getEmbeddedDataDir(config = {}) {
    return path.resolve(
        process.env.PGLITE_DATA_DIR ||
        config.embeddedDataDir ||
        path.join(__dirname, "..", "Saved", "PGlite")
    );
}

async function connectEmbedded(config = {}) {
    if (embeddedDb) return embeddedDb;

    const dataDir = getEmbeddedDataDir(config);
    fs.mkdirSync(path.dirname(dataDir), { recursive: true });

    embeddedDb = new PGlite(dataDir);
    await embeddedDb.query("SELECT 1");

    if (config.autoMigrate !== false && process.env.PG_AUTO_MIGRATE !== "false") {
        await applySchema(embeddedDb);
    }

    connected = true;
    backend = "pglite";
    return embeddedDb;
}

async function connect(config = {}) {
    if (pool) return pool;
    if (embeddedDb) return embeddedDb;

    if (config.embedded === true || process.env.PG_EMBEDDED === "true") {
        return connectEmbedded(config);
    }

    pool = new Pool(buildPoolConfig(config));
    pool.on("error", (err) => {
        connected = false;
        console.error("Unexpected PostgreSQL pool error:", err);
    });

    try {
        const client = await pool.connect();
        try {
            await client.query("SELECT 1");
            if (config.autoMigrate !== false && process.env.PG_AUTO_MIGRATE !== "false") {
                await applySchema(client);
            }
            connected = true;
            backend = "postgres";
        } finally {
            client.release();
        }

        return pool;
    } catch (error) {
        await pool.end().catch(() => {});
        pool = null;

        if (!shouldUseEmbeddedFallback(config, error)) throw error;

        console.warn(`PostgreSQL unreachable (${error.code || error.message}). Using embedded PGlite database instead.`);
        return connectEmbedded(config);
    }
}

function getPool() {
    if (!pool && !embeddedDb) {
        throw new Error("Database is not initialized. Call connect() during backend startup first.");
    }
    return pool || embeddedDb;
}

async function query(text, params = []) {
    return getPool().query(text, params);
}

async function close() {
    if (pool) await pool.end();
    if (embeddedDb) await embeddedDb.close();
    pool = null;
    embeddedDb = null;
    connected = false;
    backend = "";
}

function isConnected() {
    return connected;
}

function getBackend() {
    return backend;
}

module.exports = {
    close,
    connect,
    getBackend,
    getPool,
    isConnected,
    query
};
