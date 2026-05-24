const { createModel } = require("../database/pgModel.js");

module.exports = createModel({
    table: "mmcodes",
    primaryKey: "code_lower",
    columns: {
        _id: { column: "id", type: "text" },
        created: { column: "created", type: "timestamptz" },
        code: { column: "code", type: "text" },
        code_lower: { column: "code_lower", type: "text" },
        ip: { column: "ip", type: "text" },
        port: { column: "port", type: "number" }
    },
    defaults: {
        created: () => new Date()
    }
});
