const { createModel } = require("../database/pgModel.js");

module.exports = createModel({
    table: "fingerprints",
    columns: {
        _id: { column: "id", type: "text" },
        accountId: { column: "account_id", type: "text" },
        version: { column: "version", type: "number" },
        fingerprintHash: { column: "fingerprint_hash", type: "text" },
        hwid: { column: "hwid", type: "jsonb" },
        network: { column: "network", type: "jsonb" },
        scores: { column: "scores", type: "jsonb" },
        flags: { column: "flags", type: "jsonb" },
        history: { column: "history", type: "jsonb" },
        metadata: { column: "metadata", type: "jsonb" },
        createdAt: { column: "created_at", type: "timestamptz" },
        updatedAt: { column: "updated_at", type: "timestamptz" }
    },
    jsonFields: ["hwid", "network", "scores", "flags", "history", "metadata"],
    timestamps: true,
    defaults: {
        version: 1,
        hwid: () => ({}),
        network: () => ({}),
        scores: () => ({ match: 0, spoof: 0, trust: 50, evasion: 0, final: 50 }),
        flags: () => ({ spoofDetected: false, vmDetected: false, inconsistencies: [], suspiciousPatterns: [] }),
        history: () => ({
            firstSeen: new Date(),
            lastSeen: new Date(),
            seenCount: 1,
            ipHistory: [],
            changes: []
        }),
        metadata: () => ({})
    }
});
