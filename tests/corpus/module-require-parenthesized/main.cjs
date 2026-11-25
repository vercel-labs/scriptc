/* A parenthesized require is the same loader call: the declaration loads
 * the module at its position and the binding holds the value, whether the
 * initializer is bare or wrapped. */
const child = (require("./child.cjs"));
console.log("program", child.answer);

const json = ((require("./data.json")));
console.log("json", json.v);

const path = (require("node:path"));
console.log("builtin", path.basename("/a/b.txt") === require("node:path").basename("/a/b.txt"));
