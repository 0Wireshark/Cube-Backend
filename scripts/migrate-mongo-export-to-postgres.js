require("dotenv").config();

const fs = require("fs");
const path = require("path");
const postgres = require("../database/postgres.js");
const config = require("../structs/config.js");

const User = require("../model/user.js");
const Profile = require("../model/profiles.js");
const Friends = require("../model/friends.js");
const Arena = require("../model/arena.js");
const UserStats = require("../model/userstats.js");
const SACCodes = require("../model/saccodes.js");
const MMCodes = require("../model/mmcodes.js");
const LaunchTicket = require("../model/launchtickets.js");
const Fingerprint = require("../model/fingerprint.js");
const BanRecord = require("../model/banrecord.js");

const collections = [
    { file: "users", model: User, key: "accountId" },
    { file: "profiles", model: Profile, key: "accountId" },
    { file: "friends", model: Friends, key: "accountId" },
    { file: "arena", model: Arena, key: "accountId" },
    { file: "userstats", model: UserStats, key: "accountId" },
    { file: "SACcodes", model: SACCodes, key: "code_lower" },
    { file: "saccodes", model: SACCodes, key: "code_lower" },
    { file: "mmcodes", model: MMCodes, key: "code_lower" },
    { file: "launchtickets", model: LaunchTicket, key: "login" },
    { file: "fingerprints", model: Fingerprint, key: "_id" },
    { file: "banrecords", model: BanRecord, key: "_id" }
];

function normalizeExtendedJson(value) {
    if (Array.isArray(value)) return value.map(normalizeExtendedJson);
    if (!value || typeof value !== "object") return value;

    if (value.$oid) return String(value.$oid);
    if (value.$date) return new Date(value.$date);
    if (value.$numberInt !== undefined) return Number(value.$numberInt);
    if (value.$numberLong !== undefined) return Number(value.$numberLong);
    if (value.$numberDouble !== undefined) return Number(value.$numberDouble);
    if (value.$boolean !== undefined) return Boolean(value.$boolean);

    const out = {};
    for (const [key, nested] of Object.entries(value)) {
        out[key] = normalizeExtendedJson(nested);
    }
    return out;
}

function readExportFile(filePath) {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) return [];

    if (raw.startsWith("[")) {
        return JSON.parse(raw).map(normalizeExtendedJson);
    }

    return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => normalizeExtendedJson(JSON.parse(line)));
}

function findExportFile(directory, baseName) {
    const candidates = [
        `${baseName}.json`,
        `${baseName}.jsonl`,
        `${baseName}.ndjson`
    ];

    for (const candidate of candidates) {
        const filePath = path.join(directory, candidate);
        if (fs.existsSync(filePath)) return filePath;
    }

    return null;
}

async function upsertDocument(model, key, doc) {
    if (doc._id && typeof doc._id === "object") {
        doc._id = normalizeExtendedJson(doc._id);
    }

    const keyValue = doc[key];
    if (!keyValue) {
        await model.create(doc);
        return "inserted";
    }

    const filter = { [key]: keyValue };
    const existing = await model.findOne(filter);
    if (existing) {
        await model.updateOne(filter, { $set: doc });
        return "updated";
    }

    await model.create(doc);
    return "inserted";
}

async function migrateCollection(directory, entry, seenFiles) {
    const filePath = findExportFile(directory, entry.file);
    if (!filePath || seenFiles.has(filePath)) return null;
    seenFiles.add(filePath);

    const docs = readExportFile(filePath);
    const stats = { inserted: 0, updated: 0, failed: 0 };

    for (const doc of docs) {
        try {
            const result = await upsertDocument(entry.model, entry.key, doc);
            stats[result] += 1;
        } catch (error) {
            stats.failed += 1;
            console.error(`[${entry.file}] failed to migrate document:`, error.message);
        }
    }

    return { collection: entry.file, filePath, total: docs.length, ...stats };
}

async function main() {
    const exportDir = path.resolve(process.argv[2] || process.env.MONGO_EXPORT_DIR || "mongo-export");
    if (!fs.existsSync(exportDir)) {
        console.error(`Export directory not found: ${exportDir}`);
        console.error("Export example: mongoexport --db CUBE --collection users --jsonArray --out mongo-export/users.json");
        process.exit(1);
    }

    await postgres.connect(config.postgres || {});

    const seenFiles = new Set();
    const summaries = [];
    for (const entry of collections) {
        const summary = await migrateCollection(exportDir, entry, seenFiles);
        if (summary) summaries.push(summary);
    }

    console.table(summaries.map(({ collection, total, inserted, updated, failed }) => ({
        collection,
        total,
        inserted,
        updated,
        failed
    })));

    await postgres.close();
}

main().catch(async (error) => {
    console.error(error);
    await postgres.close().catch(() => {});
    process.exit(1);
});
