// An island module that answers plain objects, as a schema builder does.
exports.make = (name) => ({ name, fields: [] });
exports.compile = (schema) => ({ check: (value) => typeof value === "object" && value !== null, of: schema.name, schema });
