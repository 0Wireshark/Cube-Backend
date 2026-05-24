const { createModel } = require("../database/pgModel.js");

module.exports = createModel({
    table: "friends",
    primaryKey: "accountId",
    columns: {
        _id: { column: "id", type: "text" },
        created: { column: "created", type: "timestamptz" },
        accountId: { column: "account_id", type: "text" },
        list: { column: "list", type: "jsonb" }
    },
    jsonFields: ["list"],
    defaults: {
        created: () => new Date(),
        list: () => ({ accepted: [], incoming: [], outgoing: [], blocked: [] })
    }
});
