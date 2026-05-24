const { createModel } = require("../database/pgModel.js");

const statFields = [
    "placetop1",
    "placetop3",
    "placetop5",
    "placetop6",
    "placetop10",
    "placetop12",
    "placetop25",
    "kills",
    "matchesplayed",
    "minutesplayed",
    "playersoutlived",
    "score"
];

function createModeStats() {
    return statFields.reduce((stats, field) => {
        stats[field] = 0;
        return stats;
    }, {});
}

module.exports = createModel({
    table: "userstats",
    primaryKey: "accountId",
    columns: {
        _id: { column: "id", type: "text" },
        created: { column: "created", type: "timestamptz" },
        updated: { column: "updated", type: "timestamptz" },
        accountId: { column: "account_id", type: "text" },
        solo: { column: "solo", type: "jsonb" },
        duo: { column: "duo", type: "jsonb" },
        trio: { column: "trio", type: "jsonb" },
        squad: { column: "squad", type: "jsonb" },
        ltm: { column: "ltm", type: "jsonb" }
    },
    jsonFields: ["solo", "duo", "trio", "squad", "ltm"],
    defaults: {
        created: () => new Date(),
        updated: () => new Date(),
        solo: createModeStats,
        duo: createModeStats,
        trio: createModeStats,
        squad: createModeStats,
        ltm: createModeStats
    }
});
