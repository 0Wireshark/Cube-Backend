const { createModel } = require("../database/pgModel.js");

module.exports = createModel({
    table: "arena",
    primaryKey: "accountId",
    columns: {
        _id: { column: "id", type: "text" },
        accountId: { column: "account_id", type: "text" },
        hype: { column: "hype", type: "number" },
        division: { column: "division", type: "number" }
    },
    defaults: {
        hype: 0,
        division: 0
    }
});
