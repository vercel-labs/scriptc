/* module.require is the CommonJS module object's own copy of the loader:
 * Node resolves it from the module it names, exactly like the bare
 * `require` identifier. A JSON document is one shared parsed object,
 * a program module its exports value, a builtin its namespace, and the
 * same object comes back at every call. */
const json = module.require("./data.json");
console.log("json", json.v, json.name, json.nested.deep, json.list.join(","), json.flag);
console.log("stringify", JSON.stringify(json));
console.log("expr", module.require("./data.json").name);
const child = module.require("./child.cjs");
console.log("program", child.answer);
console.log("identity", module.require("./data.json") === json);
