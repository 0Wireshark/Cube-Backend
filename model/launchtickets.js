const { createModel } = require("../database/pgModel.js");

module.exports = createModel({
    table: "launch_tickets",
    primaryKey: "login",
    columns: {
        _id: { column: "id", type: "text" },
        login: { column: "login", type: "text" },
        password: { column: "password", type: "text" },
        accountId: { column: "account_id", type: "text" },
        expiresAt: { column: "expires_at", type: "timestamptz" }
    }
});
