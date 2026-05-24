const express = require("express");
const app = express.Router();
const functions = require("../structs/functions.js");
const motdTargetTemplate = require("./../responses/motdTarget.json");

const motdTargetCache = new Map();

function getMotdTargetResponse(language) {
    const cacheKey = language || "en";
    if (motdTargetCache.has(cacheKey)) return motdTargetCache.get(cacheKey);

    const motdTarget = JSON.parse(JSON.stringify(motdTargetTemplate));
    try {
        motdTarget.contentItems.forEach(item => {
            item.contentFields.title = item.contentFields.title[cacheKey];
            item.contentFields.body = item.contentFields.body[cacheKey];
        })
    } catch (err) {}

    const body = JSON.stringify(motdTarget);
    motdTargetCache.set(cacheKey, body);
    return body;
}

app.get("/content/api/pages/fortnite-game/spark-tracks", async (req, res) => {
    const sparkTracks = require("./../responses/sparkTracks.json");

    res.json(sparkTracks)
})

app.get("/content/api/pages/*", async (req, res) => {
    res.type("application/json").send(functions.getContentPagesResponse(req));
});

app.post("/api/v1/fortnite-br/surfaces/motd/target", async (req, res) => {
    res.type("application/json").send(getMotdTargetResponse(req.body?.language));
})

module.exports = app;
