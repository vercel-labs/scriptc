// util.types.isModuleNamespaceObject over the namespaces a JavaScript source
// takes as values: a module whose exports all bindings that never change
// after initialization is a copy of those values, a module with a mutable
// export is the runtime's live namespace, and either way taking a namespace
// twice answers the one object Node answers for the module. The builtin
// namespaces and the sub-module members answer as in the TypeScript form.
import * as util from "node:util";
import { types } from "node:util";
import * as direct from "node:util/types";
import * as os from "node:os";
import * as fixed from "./fixed.js";
import * as again from "./fixed.js";
import * as mutable from "./mutable.js";
import * as mod from "./mod.js";

const held = fixed;
console.log("direct", types.isModuleNamespaceObject(fixed));
console.log("reimport", types.isModuleNamespaceObject(again));
console.log("held", types.isModuleNamespaceObject(held));
console.log("same object", fixed === held, again === fixed);
console.log(
  "bindings",
  util.types.isModuleNamespaceObject(mod),
  types.isModuleNamespaceObject(os),
  direct.isModuleNamespaceObject(util),
);
console.log("other brands", types.isDate(fixed), types.isRegExp(os));
console.log("keys", Object.keys(fixed).join(","));
console.log("direct spelling", direct.isModuleNamespaceObject(fixed));
console.log("submodule member", types.isModuleNamespaceObject(util.types));
console.log(
  "dynamic",
  types.isModuleNamespaceObject(await import("./mod.js")),
  types.isModuleNamespaceObject(await import("./mutable.js")),
  types.isModuleNamespaceObject(await import("node:events")),
);
console.log("mutable", types.isModuleNamespaceObject(mutable));
mutable.bump();
console.log("mutable after", types.isModuleNamespaceObject(mutable), mutable.counter);
// Read by a function that takes the value untyped: the namespace object the
// runtime carries answers as Node's does, the CommonJS exports object does
// not.
const brand = (label, value) => console.log(label, types.isModuleNamespaceObject(value));
brand("escaped copy", fixed);
brand("escaped mutable", mutable);
brand("escaped builtin", os);
brand("escaped member", util.types);
console.log("object", types.isModuleNamespaceObject({}));
console.log("null prototype", types.isModuleNamespaceObject(Object.create(null)));
console.log("string", types.isModuleNamespaceObject("Module"));
console.log("null", types.isModuleNamespaceObject(null));
