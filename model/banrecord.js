const { createModel } = require("../database/pgModel.js");

module.exports = createModel({
    table: "ban_records",
    columns: {
        _id: { column: "id", type: "text" },
        accountId: { column: "account_id", type: "text" },
        username: { column: "username", type: "text" },
        banType: { column: "ban_type", type: "text" },
        permanent: { column: "permanent", type: "boolean" },
        expiresAt: { column: "expires_at", type: "timestamptz" },
        reason: { column: "reason", type: "text" },
        detailedReason: { column: "detailed_reason", type: "text" },
        fingerprintHash: { column: "fingerprint_hash", type: "text" },
        fingerprintSnapshot: { column: "fingerprint_snapshot", type: "jsonb" },
        scores: { column: "scores", type: "jsonb" },
        evidence: { column: "evidence", type: "jsonb" },
        bannedBy: { column: "banned_by", type: "text" },
        moderatorId: { column: "moderator_id", type: "text" },
        active: { column: "active", type: "boolean" },
        appealed: { column: "appealed", type: "boolean" },
        appealReason: { column: "appeal_reason", type: "text" },
        appealedAt: { column: "appealed_at", type: "timestamptz" },
        webhookSent: { column: "webhook_sent", type: "boolean" },
        webhookSentAt: { column: "webhook_sent_at", type: "timestamptz" },
        history: { column: "history", type: "jsonb" },
        createdAt: { column: "created_at", type: "timestamptz" },
        updatedAt: { column: "updated_at", type: "timestamptz" }
    },
    jsonFields: ["fingerprintSnapshot", "scores", "evidence", "history"],
    timestamps: true,
    defaults: {
        permanent: true,
        expiresAt: null,
        detailedReason: null,
        fingerprintSnapshot: () => ({}),
        scores: () => ({}),
        evidence: () => ({ flags: [], inconsistencies: [], relatedAccounts: [], clusterIds: [] }),
        bannedBy: "SYSTEM",
        moderatorId: null,
        active: true,
        appealed: false,
        appealReason: null,
        appealedAt: null,
        webhookSent: false,
        webhookSentAt: null,
        history: () => ({ previousBans: 0, previousEvasions: 0 })
    }
});
