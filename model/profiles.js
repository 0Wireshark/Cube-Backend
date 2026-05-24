const { createModel } = require("../database/pgModel.js");

module.exports = createModel({
    table: "profiles",
    primaryKey: "accountId",
    columns: {
        _id: { column: "id", type: "text" },
        created: { column: "created", type: "timestamptz" },
        accountId: { column: "account_id", type: "text" },
        profiles: { column: "profiles", type: "jsonb" }
    },
    jsonFields: ["profiles"],
    defaults: {
        created: () => new Date(),
        profiles: () => ({})
    }
});
