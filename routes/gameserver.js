const express = require("express");
const app = express.Router();
const log = require("../structs/log.js");
const gsAuth = require("../structs/gsAuth.js");
const gameServerHeartbeat = require("../structs/gameServerHeartbeat.js");

gameServerHeartbeat.registerRoutes(app, { forwardToMatchmaker: true });

app.post("/gs/validate", (req, res) => {
    try {
        const signedRequest = gsAuth.verifySignedRequest(req);
        if (!signedRequest.ok) {
            log.error(`GS validate signature denied: ${signedRequest.reason} (ip=${req.ip}, serverId=${signedRequest.serverId || "unknown"})`);
            return res.status(signedRequest.status || 401).json({ ok: false, reason: signedRequest.reason });
        }

        if (signedRequest.disabled === true) {
            return res.json({ ok: true, disabled: true });
        }

        let accountId = typeof req.body?.accountId === "string" ? req.body.accountId : "";
        if (!accountId) {
            log.error(`GS validate failed: missing accountId (ip=${req.ip})`);
            return res.status(400).json({ ok: false, reason: "missing_account" });
        }

        const bodyServerId = typeof req.body?.serverId === "string" ? req.body.serverId.trim() : "";
        if (bodyServerId && bodyServerId !== signedRequest.serverId) {
            log.error(`GS validate failed: body/header serverId mismatch (body=${bodyServerId}, header=${signedRequest.serverId})`);
            return res.status(403).json({ ok: false, reason: "server_id_mismatch" });
        }

        const decision = gsAuth.consumeJoinReservation({
            accountId,
            playlist: typeof req.body?.playlist === "string" ? req.body.playlist : "",
            serverId: signedRequest.serverId
        });

        if (!decision.ok) {
            log.error(`GS validate denied: ${decision.reason} (accountId=${accountId}, normalized=${decision.accountId || "unknown"}, serverId=${signedRequest.serverId})`);
            return res.status(403).json({ ok: false, reason: decision.reason });
        }

        log.debug(`GS validate OK (accountId=${accountId}, normalized=${decision.accountId}, serverId=${signedRequest.serverId})`);
        return res.json({ ok: true, decision: "allow" });
    } catch (err) {
        log.error(`GS validate error: ${err && err.message ? err.message : err}`);
        return res.status(500).json({ ok: false, reason: "internal_error" });
    }
});

module.exports = app;
