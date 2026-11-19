"use strict";
// A require binding used as a value is the module's real exports object:
// extensible, so a consumer can add properties, in the order they land.
const lib = require("./lib");
lib.extra = 1;
console.log(Object.keys(lib).join(","), lib.extra);
console.log(Object.isExtensible(lib), Object.isFrozen(lib), Object.isSealed(lib));
console.log(require("util").types.isModuleNamespaceObject(lib));
console.log(Object.getOwnPropertyDescriptor(lib, "version"));
console.log(lib);
console.log(JSON.stringify(lib), lib.helper());
delete lib.extra;
console.log("extra" in lib, Object.keys(lib).length);
