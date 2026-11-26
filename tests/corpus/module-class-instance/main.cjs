/* In Node every CommonJS module is an instance of node:module's `Module`:
 * the object exposes Module.prototype through Object.getPrototypeOf, the
 * prototype's constructor is the `Module` export, and instanceof holds for
 * the requiring module and for every module it loads. The prototype's own
 * names are Node's, and its loading members are functions (a compiled
 * program refuses to call them, since it loads no module at run time). */
const nodeModule = require("node:module");

console.log("class", nodeModule.Module.name, nodeModule.Module.length);
console.log("instanceof", module instanceof nodeModule.Module);
console.log("prototype", Object.getPrototypeOf(module) === nodeModule.Module.prototype);
console.log("constructor", Object.getPrototypeOf(module).constructor === nodeModule.Module);
console.log(
  "names",
  Object.getOwnPropertyNames(Object.getPrototypeOf(module)).sort().join(","),
);
const prototype = Object.getPrototypeOf(module);
console.log(
  "members",
  typeof prototype.require,
  typeof prototype.load,
  typeof prototype._compile,
  prototype.parent,
  prototype.isPreloading,
);
console.log("child", require("./child.cjs") === 1, require.main instanceof nodeModule.Module);
