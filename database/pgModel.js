const crypto = require("crypto");
const { query } = require("./postgres.js");

function quoteIdent(value) {
    return `"${String(value).replace(/"/g, "\"\"")}"`;
}

function clone(value) {
    if (value === undefined || value === null) return value;
    if (value instanceof Date) return new Date(value.getTime());
    return JSON.parse(JSON.stringify(value));
}

function defaultValue(value) {
    return typeof value === "function" ? value() : clone(value);
}

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date) && !(value instanceof RegExp);
}

function getByPath(source, path) {
    const parts = String(path).split(".");
    let current = source;
    for (const part of parts) {
        if (current === undefined || current === null) return undefined;
        current = current[part];
    }
    return current;
}

function setByPath(source, path, value) {
    const parts = String(path).split(".");
    let current = source;
    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (!isPlainObject(current[part])) current[part] = {};
        current = current[part];
    }
    current[parts[parts.length - 1]] = value;
}

function unsetByPath(source, path) {
    const parts = String(path).split(".");
    let current = source;
    for (let i = 0; i < parts.length - 1; i++) {
        current = current?.[parts[i]];
        if (!isPlainObject(current)) return;
    }
    delete current[parts[parts.length - 1]];
}

function compareValues(left, right) {
    if (left instanceof Date || right instanceof Date) {
        return new Date(left).getTime() - new Date(right).getTime();
    }
    if (typeof left === "number" || typeof right === "number") {
        return Number(left || 0) - Number(right || 0);
    }
    return String(left ?? "").localeCompare(String(right ?? ""));
}

function hasOperator(value) {
    return isPlainObject(value) && Object.keys(value).some((key) => key.startsWith("$"));
}

function normalizeError(error) {
    if (error?.code === "23505") {
        error.code = 11000;
    }
    return error;
}

class PgQuery {
    constructor(executor) {
        this.executor = executor;
        this._lean = false;
        this._limit = null;
        this._projection = null;
        this._sort = null;
    }

    lean() {
        this._lean = true;
        return this;
    }

    limit(value) {
        const limit = Number(value);
        this._limit = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : null;
        return this;
    }

    select(value) {
        this._projection = value;
        return this;
    }

    sort(value) {
        this._sort = value;
        return this;
    }

    async exec() {
        return this.executor(this);
    }

    then(resolve, reject) {
        return this.exec().then(resolve, reject);
    }

    catch(reject) {
        return this.exec().catch(reject);
    }

    finally(callback) {
        return this.exec().finally(callback);
    }
}

class PgDocument {
    constructor(model, data = {}, isNew = true) {
        Object.defineProperty(this, "__model", { value: model, enumerable: false });
        Object.defineProperty(this, "__isNew", { value: isNew, writable: true, enumerable: false });
        Object.assign(this, model.applyDefaults(data));
    }

    async save() {
        const saved = await this.__model._saveDocument(this);
        Object.keys(this).forEach((key) => delete this[key]);
        Object.assign(this, saved.toObject());
        this.__isNew = false;
        return this;
    }

    async updateOne(update, options = {}) {
        const filter = this._id ? { _id: this._id } : this.__model.primaryFilter(this);
        return this.__model.updateOne(filter, update, options);
    }

    toObject() {
        const data = {};
        for (const key of Object.keys(this)) {
            data[key] = clone(this[key]);
        }
        return data;
    }

    toJSON() {
        return this.toObject();
    }
}

function createModel(definition) {
    const columns = {};
    for (const [field, value] of Object.entries(definition.columns)) {
        columns[field] = typeof value === "string" ? { column: value } : value;
    }

    class Model extends PgDocument {
        constructor(data = {}) {
            super(Model, data, true);
        }

        static get tableName() {
            return definition.table;
        }

        static get columns() {
            return columns;
        }

        static get defaults() {
            return definition.defaults || {};
        }

        static get jsonFields() {
            return new Set(definition.jsonFields || []);
        }

        static get primaryKey() {
            return definition.primaryKey || "_id";
        }

        static applyDefaults(data = {}) {
            const out = {};
            for (const [field, value] of Object.entries(this.defaults)) {
                out[field] = defaultValue(value);
            }
            for (const [field, value] of Object.entries(data || {})) {
                if (value !== undefined) out[field] = clone(value);
            }
            if (!out._id && data.id) out._id = data.id;
            return out;
        }

        static fieldDefinition(field) {
            return columns[field] || null;
        }

        static fieldSql(field, values, rawValue = undefined) {
            if (field === "_id") return { sql: "id", type: "text" };

            const direct = this.fieldDefinition(field);
            if (direct) return { sql: quoteIdent(direct.column), type: direct.type || "text" };

            const [root, ...rest] = String(field).split(".");
            const rootDef = this.fieldDefinition(root);
            if (!rootDef || rest.length === 0) {
                return { sql: quoteIdent(field), type: "text" };
            }

            const pgPath = rest.join(",");
            const jsonSql = `${quoteIdent(rootDef.column)} #>> '{${pgPath}}'`;
            if (rawValue instanceof Date) return { sql: `(${jsonSql})::timestamptz`, type: "timestamptz" };
            if (typeof rawValue === "number") return { sql: `NULLIF(${jsonSql}, '')::numeric`, type: "numeric" };
            if (typeof rawValue === "boolean") return { sql: `NULLIF(${jsonSql}, '')::boolean`, type: "boolean" };
            return { sql: jsonSql, type: "text" };
        }

        static buildWhere(filter = {}, values = []) {
            const clauses = [];

            for (const [field, expected] of Object.entries(filter || {})) {
                if (field === "$or") {
                    const parts = (Array.isArray(expected) ? expected : [])
                        .map((item) => this.buildWhere(item, values).sql)
                        .filter(Boolean);
                    if (parts.length > 0) clauses.push(`(${parts.map((part) => part.replace(/^ WHERE /, "")).join(" OR ")})`);
                    continue;
                }

                if (expected instanceof RegExp) {
                    const fieldSql = this.fieldSql(field, values).sql;
                    values.push(expected.source);
                    clauses.push(`${fieldSql} ${expected.ignoreCase ? "~*" : "~"} $${values.length}`);
                    continue;
                }

                if (hasOperator(expected)) {
                    for (const [operator, value] of Object.entries(expected)) {
                        const fieldSql = this.fieldSql(field, values, value).sql;
                        if (operator === "$ne") {
                            values.push(value);
                            clauses.push(`${fieldSql} IS DISTINCT FROM $${values.length}`);
                        } else if (operator === "$in") {
                            values.push(Array.isArray(value) ? value : []);
                            clauses.push(`${fieldSql} = ANY($${values.length})`);
                        } else if (operator === "$gt" || operator === "$gte" || operator === "$lt" || operator === "$lte") {
                            const op = { $gt: ">", $gte: ">=", $lt: "<", $lte: "<=" }[operator];
                            values.push(value);
                            clauses.push(`${fieldSql} ${op} $${values.length}`);
                        } else if (operator === "$not" && value instanceof RegExp) {
                            values.push(value.source);
                            clauses.push(`NOT (${fieldSql} ${value.ignoreCase ? "~*" : "~"} $${values.length})`);
                        }
                    }
                    continue;
                }

                const fieldSql = this.fieldSql(field, values, expected).sql;
                if (expected === null) {
                    clauses.push(`${fieldSql} IS NULL`);
                } else {
                    values.push(expected);
                    clauses.push(`${fieldSql} = $${values.length}`);
                }
            }

            return {
                sql: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "",
                values
            };
        }

        static fromRow(row, lean = false) {
            if (!row) return null;
            const data = { _id: row.id };
            for (const [field, config] of Object.entries(columns)) {
                if (field === "_id") continue;
                data[field] = clone(row[config.column]);
            }
            const hydrated = this.applyDefaults(data);
            return lean ? hydrated : this.hydrate(hydrated);
        }

        static hydrate(data) {
            return new PgDocument(this, data, false);
        }

        static toRow(data, includeId = true) {
            const row = {};
            if (includeId) row.id = data._id || crypto.randomUUID();
            for (const [field, config] of Object.entries(columns)) {
                if (field === "_id") continue;
                if (data[field] !== undefined) row[config.column] = clone(data[field]);
            }
            return row;
        }

        static project(data, projection) {
            if (!projection) return data;
            if (typeof projection === "string") {
                projection = projection.split(/\s+/).filter(Boolean).reduce((acc, key) => {
                    acc[key] = 1;
                    return acc;
                }, {});
            }
            if (!isPlainObject(projection) || Object.keys(projection).length === 0) return data;

            const includeMode = Object.values(projection).some((value) => Number(value) === 1);
            if (includeMode) {
                const out = {};
                for (const [field, enabled] of Object.entries(projection)) {
                    if (Number(enabled) !== 1) continue;
                    const value = getByPath(data, field);
                    if (value !== undefined) setByPath(out, field, value);
                }
                if (data._id && projection._id !== 0) out._id = data._id;
                return out;
            }

            const out = clone(data);
            for (const [field, enabled] of Object.entries(projection)) {
                if (Number(enabled) === 0) unsetByPath(out, field);
            }
            return out;
        }

        static sortRows(rows, sortSpec) {
            if (!sortSpec) return rows;
            const entries = Object.entries(sortSpec);
            if (entries.length === 0) return rows;
            return rows.sort((a, b) => {
                for (const [field, direction] of entries) {
                    const delta = compareValues(getByPath(a, field), getByPath(b, field));
                    if (delta !== 0) return Number(direction) < 0 ? -delta : delta;
                }
                return 0;
            });
        }

        static async _find(filter = {}, projection = null, queryOptions = {}) {
            const values = [];
            const where = this.buildWhere(filter, values);
            const result = await query(`SELECT * FROM ${quoteIdent(this.tableName)}${where.sql}`, where.values);
            let rows = result.rows.map((row) => this.fromRow(row, queryOptions.lean));
            rows = this.sortRows(rows, queryOptions.sort);
            if (queryOptions.limit !== null && queryOptions.limit !== undefined) rows = rows.slice(0, queryOptions.limit);
            const activeProjection = queryOptions.projection || projection;
            if (activeProjection) rows = rows.map((row) => this.project(row, activeProjection));
            return rows;
        }

        static find(filter = {}, projection = null) {
            return new PgQuery((options) => this._find(filter, projection, {
                lean: options._lean,
                limit: options._limit,
                projection: options._projection,
                sort: options._sort
            }));
        }

        static findOne(filter = {}, projection = null) {
            return new PgQuery(async (options) => {
                const rows = await this._find(filter, projection, {
                    lean: options._lean,
                    limit: options._sort ? null : 1,
                    projection: options._projection,
                    sort: options._sort
                });
                return rows[0] || null;
            });
        }

        static async create(data) {
            if (Array.isArray(data)) return Promise.all(data.map((item) => this.create(item)));
            const now = new Date();
            const payload = this.applyDefaults(data);
            if (definition.timestamps) {
                payload.createdAt = payload.createdAt || now;
                payload.updatedAt = payload.updatedAt || now;
            }
            const row = this.toRow(payload, true);
            const keys = Object.keys(row);
            const values = Object.values(row);
            const placeholders = keys.map((_, index) => `$${index + 1}`);
            try {
                const result = await query(
                    `INSERT INTO ${quoteIdent(this.tableName)} (${keys.map(quoteIdent).join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *`,
                    values
                );
                return this.fromRow(result.rows[0], false);
            } catch (error) {
                throw normalizeError(error);
            }
        }

        static primaryFilter(data) {
            if (data._id) return { _id: data._id };
            if (this.primaryKey && data[this.primaryKey] !== undefined) return { [this.primaryKey]: data[this.primaryKey] };
            throw new Error(`Cannot build primary filter for ${this.tableName}`);
        }

        static async _saveDocument(document) {
            const data = document.toObject ? document.toObject() : clone(document);
            if (definition.timestamps && !document.__isNew) {
                data.updatedAt = new Date();
            }
            if (document.__isNew || !data._id) {
                return this.create(data);
            }

            const row = this.toRow(data, false);
            const keys = Object.keys(row);
            if (keys.length === 0) return this.findOne({ _id: data._id });
            const assignments = keys.map((key, index) => `${quoteIdent(key)} = $${index + 1}`);
            const values = Object.values(row);
            values.push(data._id);
            try {
                const result = await query(
                    `UPDATE ${quoteIdent(this.tableName)} SET ${assignments.join(", ")} WHERE id = $${values.length} RETURNING *`,
                    values
                );
                return this.fromRow(result.rows[0], false);
            } catch (error) {
                throw normalizeError(error);
            }
        }

        static extractInsertData(filter = {}) {
            const out = {};
            for (const [field, value] of Object.entries(filter || {})) {
                if (field.startsWith("$")) continue;
                if (hasOperator(value) || value instanceof RegExp) continue;
                out[field] = value;
            }
            return out;
        }

        static applyUpdate(target, update = {}, isInsert = false) {
            const out = clone(target || {});
            const operators = Object.keys(update || {}).filter((key) => key.startsWith("$"));

            if (operators.length === 0) {
                return { ...out, ...clone(update) };
            }

            if (isInsert && update.$setOnInsert) {
                for (const [path, value] of Object.entries(update.$setOnInsert)) setByPath(out, path, value);
            }
            if (update.$set) {
                for (const [path, value] of Object.entries(update.$set)) setByPath(out, path, value);
            }
            if (update.$inc) {
                for (const [path, value] of Object.entries(update.$inc)) {
                    const current = Number(getByPath(out, path) || 0);
                    setByPath(out, path, current + Number(value || 0));
                }
            }
            if (update.$unset) {
                for (const path of Object.keys(update.$unset)) unsetByPath(out, path);
            }
            if (definition.timestamps) out.updatedAt = new Date();
            return out;
        }

        static async updateOne(filter, update, options = {}) {
            const existing = await this.findOne(filter);
            if (!existing) {
                if (!options.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedId: null };
                const insertData = this.applyUpdate(this.extractInsertData(filter), update, true);
                const created = await this.create(insertData);
                return { matchedCount: 0, modifiedCount: 0, upsertedId: created._id };
            }

            const updated = this.applyUpdate(existing.toObject(), update, false);
            const saved = await this._saveDocument(this.hydrate(updated));
            return { matchedCount: 1, modifiedCount: saved ? 1 : 0, upsertedId: null };
        }

        static async updateMany(filter, update) {
            const docs = await this.find(filter);
            let modifiedCount = 0;
            for (const doc of docs) {
                const updated = this.applyUpdate(doc.toObject(), update, false);
                await this._saveDocument(this.hydrate(updated));
                modifiedCount += 1;
            }
            return { matchedCount: docs.length, modifiedCount };
        }

        static findOneAndUpdate(filter, update, options = {}) {
            return new PgQuery(async (queryOptions) => {
                const existing = await this.findOne(filter);
                if (!existing) {
                    if (!options.upsert) return null;
                    const insertData = this.applyUpdate(this.extractInsertData(filter), update, true);
                    const created = await this.create(insertData);
                    return queryOptions._lean ? created.toObject() : created;
                }

                const before = existing.toObject();
                const updated = this.applyUpdate(before, update, false);
                const saved = await this._saveDocument(this.hydrate(updated));
                const shouldReturnNew = options.new === true || options.returnDocument === "after";
                const result = shouldReturnNew ? saved : this.hydrate(before);
                const projected = queryOptions._projection ? this.project(result, queryOptions._projection) : result;
                return queryOptions._lean && projected?.toObject ? projected.toObject() : projected;
            });
        }

        static findOneAndDelete(filter) {
            return new PgQuery(async (queryOptions) => {
                const doc = await this.findOne(filter);
                if (!doc) return null;
                await this.deleteOne({ _id: doc._id });
                return queryOptions._lean ? doc.toObject() : doc;
            });
        }

        static async deleteOne(filter) {
            const values = [];
            const where = this.buildWhere(filter, values);
            const result = await query(
                `DELETE FROM ${quoteIdent(this.tableName)} WHERE id IN (SELECT id FROM ${quoteIdent(this.tableName)}${where.sql} LIMIT 1)`,
                where.values
            );
            return { deletedCount: result.rowCount };
        }

        static async deleteMany(filter) {
            const values = [];
            const where = this.buildWhere(filter, values);
            const result = await query(`DELETE FROM ${quoteIdent(this.tableName)}${where.sql}`, where.values);
            return { deletedCount: result.rowCount };
        }

        static countDocuments(filter = {}) {
            return new PgQuery(async () => {
                const values = [];
                const where = this.buildWhere(filter, values);
                const result = await query(`SELECT COUNT(*)::int AS count FROM ${quoteIdent(this.tableName)}${where.sql}`, where.values);
                return Number(result.rows[0]?.count || 0);
            });
        }
    }

    return Model;
}

module.exports = {
    createModel,
    getByPath,
    setByPath
};
