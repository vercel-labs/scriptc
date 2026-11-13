// util.types.isModuleNamespaceObject in a JavaScript source: true asked of
// the `import * as` bindings (program module and node: builtins), a
// constant holding one and an awaited import(); false for the builtin
// sub-module members, plain objects and arrays.
import * as util from "node:util";
import { types } from "node:util";
import * as direct from "node:util/types";
import * as os from "node:os";
import * as mod from "./mod.js";

console.log(
  "bindings",
  util.types.isModuleNamespaceObject(mod),
  types.isModuleNamespaceObject(os),
  direct.isModuleNamespaceObject(util),
);
console.log("other brands", types.isDate(mod), types.isRegExp(os));

const held = mod;
const dynamic = await import("./mod.js");
console.log(
  "held and dynamic",
  types.isModuleNamespaceObject(held),
  types.isModuleNamespaceObject(dynamic),
  types.isModuleNamespaceObject(await import("node:events")),
  dynamic.beta(),
);

console.log("submodule member", types.isModuleNamespaceObject(util.types));
console.log(
  "others",
  types.isModuleNamespaceObject({}),
  types.isModuleNamespaceObject([mod]),
  types.isModuleNamespaceObject("mod"),
  types.isModuleNamespaceObject(),
);
