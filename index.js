const express = require("express");
require("dotenv").config();
const fs = require("fs");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const path = require("path");
const kv = require("./structs/kv.js");
const config = require("./structs/config.js");
const postgres = require("./database/postgres.js");
const WebSocket = require('ws');
const https = require("https");

const log = require("./structs/log.js");
const error = require("./structs/error.js");
const functions = require("./structs/functions.js");
const CheckForUpdate = require("./structs/checkforupdate.js");
const AutoBackendRestart = require("./structs/autobackendrestart.js");
const gsAuth = require("./structs/gsAuth.js");

const app = express();
const feedbackAccessRawParser = express.raw({ type: () => true, limit: "25mb" });

function isFeedbackRequest(req) {
    const url = req.originalUrl || req.url || "";
    return (
        url.startsWith("/fortnite/api/feedback") ||
        url.startsWith("/api/v1/access/fortnite/client-feedback")
    );
}

function isTelemetryIngestRequest(req) {
    const url = req.originalUrl || req.url || "";
    return (
        url.startsWith("/datarouter/api/v1/public/data") ||
        url.startsWith("/telemetry/data/datarouter/api/v1/public/data")
    );
}

gsAuth.ensureStores();
setInterval(() => gsAuth.cleanupStores(), 60000);


if (!fs.existsSync("./ClientSettings")) fs.mkdirSync("./ClientSettings");

global.JWT_SECRET = functions.MakeID();
const PORT = config.port;
const WEBSITEPORT = config.Website.websiteport;

let httpsServer;

if (config.bEnableHTTPS) {
    const httpsOptions = {
        cert: fs.readFileSync(config.ssl.cert),
        ca: fs.existsSync(config.ssl.ca) ? fs.readFileSync(config.ssl.ca) : undefined,
        key: fs.readFileSync(config.ssl.key)
    };

    httpsServer = https.createServer(httpsOptions, app);
}

if (!fs.existsSync("./ClientSettings")) fs.mkdirSync("./ClientSettings");

const tui = require("./structs/tui.js");

tui.init();

function updateTuiStats() {
    tui.updateStats({
        port: PORT,
        websitePort: WEBSITEPORT,
        database: postgres.isConnected() ? '{green-fg}CONNECTED{/green-fg}' : '{red-fg}DISCONNECTED{/red-fg}',
        xmpp: true, 
        bot: global.botConnected || false,
        players: global.Clients ? global.Clients.length : 0
    });
}

setInterval(updateTuiStats, 1000);
updateTuiStats();

const tokens = JSON.parse(fs.readFileSync("./tokenManager/tokens.json").toString());

// Clean expired tokens efficiently using filter instead of splice
for (let tokenType in tokens) {
    tokens[tokenType] = tokens[tokenType].filter(tokenData => {
        let decodedToken = jwt.decode(tokenData.token.replace("eg1~", ""));
        return DateAddHours(new Date(decodedToken.creation_date), decodedToken.hours_expire).getTime() > new Date().getTime();
    });
}

fs.writeFileSync("./tokenManager/tokens.json", JSON.stringify(tokens, null, 2));

global.accessTokens = tokens.accessTokens;
global.refreshTokens = tokens.refreshTokens;
global.clientTokens = tokens.clientTokens;
global.kv = kv;
gsAuth.ensureStores();

global.exchangeCodes = [];

let updateFound = false;

const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "./package.json")).toString());
if (!packageJson) throw new Error("Failed to parse package.json");
const version = packageJson.version;

const checkUpdates = async () => {
    if (updateFound) return;

    try {
        const updateAvailable = await CheckForUpdate.checkForUpdate(version);
        if (updateAvailable) {
            updateFound = true;
        }
    } catch (err) {
        log.error("Failed to check for updates");
    }
};

checkUpdates();

setInterval(checkUpdates, 60000);

async function connectDatabase() {
    await postgres.connect(config.postgres || {});
    const backend = postgres.getBackend && postgres.getBackend() === "pglite" ? "PGlite embedded database" : "PostgreSQL";
    log.backend(`App successfully connected to ${backend}!`);
}

app.use(rateLimit({
    windowMs: 0.5 * 60 * 1000,
    max: 55,
    skip: req => isFeedbackRequest(req) || isTelemetryIngestRequest(req)
}));
app.use("/fortnite/api/feedback", express.raw({ type: () => true, limit: "25mb" }));
app.use((req, res, next) => {
    if (!isFeedbackRequest(req) || !req.originalUrl.startsWith("/api/v1/access/fortnite/client-feedback")) return next();
    return feedbackAccessRawParser(req, res, next);
});
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf ? buf.toString("utf8") : "";
    }
}));
app.use(express.urlencoded({ extended: true }));

fs.readdirSync("./routes").forEach(fileName => {
    try {
        app.use(require(`./routes/${fileName}`));
    } catch (err) {
        log.error(`Routes Error: Failed to load ${fileName}`)
    }
});

fs.readdirSync("./Api").forEach(fileName => {
    try {
        app.use(require(`./Api/${fileName}`));
    } catch (err) {
        log.error(`CUBE API Error: Failed to load ${fileName}`)
    }
});

app.get("/unknown", (req, res) => {
    log.debug('GET /unknown endpoint called');
    res.json({ msg: "CUBE - Made by Ban2ftn and Venos" });
});

// Factorized server startup function
function startServer() {
    require("./xmpp/xmpp.js");
    if (config.discord.bUseDiscordBot === true) {
        require("./DiscordBot");
    }
    if (config.bUseAutoRotate === true) {
        require("./structs/autorotate.js");
    }
}

// Factorized error handler
async function handleServerError(err, portName, portNumber) {
    if (err.code === "EADDRINUSE") {
        log.error(`${portName} ${portNumber} is already in use!\nClosing in 3 seconds...`);
        await functions.sleep(3000);
        process.exit(1);
    } else {
        throw err;
    }
}

function startRuntimeServers() {
    let server;
    if (config.bEnableHTTPS) {
        server = httpsServer.listen(PORT, () => {
            log.backend(`Backend started listening on port ${PORT} (SSL Enabled)`);
            startServer();
        }).on("error", (err) => handleServerError(err, "Port", PORT));
    } else {
        server = app.listen(PORT, () => {
            log.backend(`Backend started listening on port ${PORT} (SSL Disabled)`);
            startServer();
        }).on("error", (err) => handleServerError(err, "Port", PORT));
    }

    if (config.bEnableAutoBackendRestart === true) {
        AutoBackendRestart.scheduleRestart(config.bRestartTime);
    }

    if (config.bEnableCalderaService === true) {
        const createCalderaService = require('./CalderaService/calderaservice');
        const calderaService = createCalderaService();

        let calderaHttpsOptions;
        if (config.bEnableHTTPS) {
            calderaHttpsOptions = {
                cert: fs.readFileSync(config.ssl.cert),
                ca: fs.existsSync(config.ssl.ca) ? fs.readFileSync(config.ssl.ca) : undefined,
                key: fs.readFileSync(config.ssl.key)
            };
        }

        if (config.bEnableHTTPS) {
            const calderaHttpsServer = https.createServer(calderaHttpsOptions, calderaService);
            
            if (!config.bGameVersion) {
                log.calderaservice("Please define a version in the config!")
                return;
            }

            calderaHttpsServer.listen(config.bCalderaServicePort, () => {
                log.calderaservice(`Caldera Service started listening on port ${config.bCalderaServicePort} (SSL Enabled)`);
            }).on("error", async (err) => {
                if (err.code === "EADDRINUSE") {
                    log.calderaservice(`Caldera Service port ${config.bCalderaServicePort} is already in use!\nClosing in 3 seconds...`);
                    await functions.sleep(3000);
                    process.exit(1);
                } else {
                    throw err;
                }
            });
        } else {
            if (!config.bGameVersion) {
                log.calderaservice("Please define a version in the config!")
                return;
            }

            calderaService.listen(config.bCalderaServicePort, () => {
                log.calderaservice(`Caldera Service started listening on port ${config.bCalderaServicePort} (SSL Disabled)`);
            }).on("error", async (err) => {
                if (err.code === "EADDRINUSE") {
                    log.calderaservice(`Caldera Service port ${config.bCalderaServicePort} is already in use!\nClosing in 3 seconds...`);
                    await functions.sleep(3000);
                    process.exit(1);
                } else {
                    throw err;
                }
            });
        }
    }

    if (config.Website.bUseWebsite === true) {
        const websiteApp = express();
        require('./Website/website')(websiteApp);

        let httpsOptions;
        if (config.bEnableHTTPS) {
            httpsOptions = {
                cert: fs.readFileSync(config.ssl.cert),
                ca: fs.existsSync(config.ssl.ca) ? fs.readFileSync(config.ssl.ca) : undefined,
                key: fs.readFileSync(config.ssl.key)
            };
        }

        if (config.bEnableHTTPS) {
            const httpsServer = https.createServer(httpsOptions, websiteApp);
            httpsServer.listen(config.Website.websiteport, () => {
                log.website(`Website started listening on port ${config.Website.websiteport} (SSL Enabled)`);
            }).on("error", async (err) => {
                if (err.code === "EADDRINUSE") {
                    log.error(`Website port ${config.Website.websiteport} is already in use!\nClosing in 3 seconds...`);
                    await functions.sleep(3000);
                    process.exit(1);
                } else {
                    throw err;
                }
            });
        } else {
            websiteApp.listen(config.Website.websiteport, () => {
                log.website(`Website started listening on port ${config.Website.websiteport} (SSL Disabled)`);
            }).on("error", async (err) => {
                if (err.code === "EADDRINUSE") {
                    log.error(`Website port ${config.Website.websiteport} is already in use!\nClosing in 3 seconds...`);
                    await functions.sleep(3000);
                    process.exit(1);
                } else {
                    throw err;
                }
            });
        }
    }
}

app.use((err, req, res, next) => {
    if (err?.type === "entity.too.large") {
        log.debug(`Payload too large: ${req.method} ${req.originalUrl}`);
        if (isFeedbackRequest(req)) return res.status(200).json({ success: true });
        return res.status(413).json({ error: "Payload too large" });
    }

    next(err);
});

app.use((req, res, next) => {
    const url = req.originalUrl;
    log.debug(`Missing endpoint: ${req.method} ${url} request port ${req.socket.localPort}`);
    if (req.url.includes("..")) {
        res.redirect("https://youtu.be/dQw4w9WgXcQ");
        return;
    }
    error.createError(
        "errors.com.epicgames.common.not_found", 
        "Sorry the resource you were trying to find could not be found", 
        undefined, 1004, undefined, 404, res
    );
});

function DateAddHours(pdate, number) {
    let date = pdate;
    date.setHours(date.getHours() + number);

    return date;
}

connectDatabase()
    .then(startRuntimeServers)
    .catch((err) => {
        log.error("PostgreSQL failed to connect. Check DATABASE_URL or the postgres section in Config/config.json.");
        log.error(err);
        process.exit(1);
    });

module.exports = app;
