/* Node's Module.prototype carries the loader's members as function values
 * with empty names and Node's lengths. A compiled program refuses to CALL
 * them (it loads no module at run time), but reading, typeof, .name,
 * .length and identity with the prototype answer exactly as Node's do. */
const nodeModule = require("node:module");
const prototype = nodeModule.Module.prototype;

console.log("types", typeof module.load, typeof module._compile, typeof module.require);
console.log("names", JSON.stringify([module.load.name, module._compile.name, module.require.name]));
console.log("lengths", module.load.length, module._compile.length, module.require.length);
console.log(
  "identity",
  module.load === prototype.load,
  module._compile === prototype._compile,
  module.require === prototype.require,
);
