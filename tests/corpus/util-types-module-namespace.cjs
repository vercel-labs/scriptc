// util.types.isModuleNamespaceObject in CommonJS: require() answers the
// module's exports object, never a namespace, so every require() result
// answers false, as do the sub-module members reached through one.
const util = require("node:util");
const { types } = require("node:util");
const direct = require("node:util/types");

console.log(
  "require",
  util.types.isModuleNamespaceObject(require("node:path")),
  types.isModuleNamespaceObject(require("node:os")),
  direct.isModuleNamespaceObject(util),
  types.isModuleNamespaceObject(direct),
);
console.log(
  "members",
  types.isModuleNamespaceObject(util.types),
  types.isModuleNamespaceObject(require("node:fs").promises),
);
console.log("others", types.isModuleNamespaceObject({ default: {} }), types.isModuleNamespaceObject([]));
