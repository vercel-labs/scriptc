// The CommonJS module-scope names Node's globals chapter lists:
// require() over builtins and a sibling module, require.resolve,
// __dirname and __filename, and the module object's metadata.
const path = require("path");
const { join, sep } = require("node:path");
const os = require("os");
const fsp = require("fs").promises;
const dep = require("./dep.cjs");

console.log(typeof __dirname, typeof __filename, path.isAbsolute(__dirname), path.isAbsolute(__filename));
console.log(path.basename(__filename), path.basename(__dirname), path.dirname(__filename) === __dirname);
console.log(join("a", "b") === "a" + sep + "b", typeof os.cpus().length, typeof fsp.readFile);
console.log(typeof require("util").inspect, typeof require, typeof require.resolve);
console.log(dep.name, dep.twice(21), dep.where === join(__dirname, "dep.cjs"));
console.log(path.basename(require.resolve("./dep.cjs")), require.resolve("fs"), require.resolve("node:path"));
console.log(typeof module, typeof module.exports, require.main === module);
console.log(typeof module.filename, module.filename === __filename, typeof module.id);
