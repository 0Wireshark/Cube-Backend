const config = require("./config.js");
const tui = require("./tui.js");

const violet = "\x1b[35m";
const lightViolet = "\x1b[95m";
const reset = "\x1b[0m";

function getTimestamp() {
    const now = new Date();
    return now.toLocaleTimeString('en-US', { hour12: false });
}

function formatLog(prefixColor, prefix, scope, ...args) {
    let msg = args.join(" ");
    let formattedMessage = `${prefixColor}${getTimestamp()}${reset} ${prefixColor}${prefix.padEnd(8)}${reset} ${lightViolet}${scope}${reset} ${msg}`;
    tui.addLog(formattedMessage);
}

function backend(...args) {
    let msg = args.join(" ");
    if (config.bEnableFormattedLogs) {
        formatLog(lightViolet, "CORE", "backend", ...args);
    } else {
        tui.addLog(`${lightViolet}CUBE Log${reset}: ${msg}`);
    }
}

function bot(...args) {
    let msg = args.join(" ");
    if (config.bEnableFormattedLogs) {
        formatLog(violet, "BOT", "discord", ...args);
    } else {
        tui.addLog(`${violet}CUBE Bot Log${reset}: ${msg}`);
    }
}

function xmpp(...args) {
    let msg = args.join(" ");
    if (config.bEnableFormattedLogs) {
        formatLog(violet, "XMPP", "socket", ...args);
    } else {
        tui.addLog(`${violet}CUBE Xmpp Log${reset}: ${msg}`);
    }
}

function error(...args) {
    let msg = args.join(" ");
    if (config.bEnableFormattedLogs) {
        formatLog(lightViolet, "ERROR", "system", ...args);
    } else {
        tui.addLog(`${lightViolet}CUBE Error Log${reset}: ${msg}`);
    }
}

function debug(...args) {
    if (config.bEnableDebugLogs) {
        let msg = args.join(" ");
        if (config.bEnableFormattedLogs) {
            formatLog(violet, "DEBUG", "trace", ...args);
        } else {
            tui.addLog(`${violet}CUBE Debug Log${reset}: ${msg}`);
        }
    }
}

function website(...args) {
    let msg = args.join(" ");
    if (config.bEnableFormattedLogs) {
        formatLog(violet, "WEB", "website", ...args);
    } else {
        tui.addLog(`${violet}CUBE Website Log${reset}: ${msg}`);
    }
}

function AutoRotation(...args) {
    if (config.bEnableAutoRotateDebugLogs) {
        let msg = args.join(" ");
        if (config.bEnableFormattedLogs) {
            formatLog(violet, "SHOP", "rotation", ...args);
        } else {
            tui.addLog(`${violet}CUBE AutoRotation Debug Log${reset}: ${msg}`);
        }
    }
}

function checkforupdate(...args) {
    let msg = args.join(" ");
    if (config.bEnableFormattedLogs) {
        formatLog(violet, "UPDATE", "version", ...args);
    } else {
        tui.addLog(`${violet}CUBE Update Log${reset}: ${msg}`);
    }
}

function autobackendrestart(...args) {
    let msg = args.join(" ");
    if (config.bEnableFormattedLogs) {
        formatLog(lightViolet, "RESTART", "scheduler", ...args);
    } else {
        tui.addLog(`${lightViolet}CUBE Auto Backend Restart${reset}: ${msg}`);
    }
}

function calderaservice(...args) {
    let msg = args.join(" ");
    if (config.bEnableFormattedLogs) {
        formatLog(lightViolet, "CALDERA", "service", ...args);
    } else {
        tui.addLog(`${lightViolet}Caldera Service${reset}: ${msg}`);
    }
}

module.exports = {
    backend,
    bot,
    xmpp,
    error,
    debug,
    website,
    AutoRotation,
    checkforupdate,
    autobackendrestart,
    calderaservice
};
