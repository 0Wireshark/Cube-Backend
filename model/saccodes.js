const { createModel } = require("../database/pgModel.js");

module.exports = createModel({
    table: "sac_codes",
    primaryKey: "code_lower",
    columns: {
        _id: { column: "id", type: "text" },
        created: { column: "created", type: "timestamptz" },
        createdby: { column: "createdby", type: "text" },
        owneraccountId: { column: "owneraccount_id", type: "text" },
        code: { column: "code", type: "text" },
        code_lower: { column: "code_lower", type: "text" },
        code_higher: { column: "code_higher", type: "text" }
    },
    defaults: {
        created: () => new Date()
    }
});
