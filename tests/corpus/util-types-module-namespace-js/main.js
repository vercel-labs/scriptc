// util.types.isModuleNamespaceObject over the namespaces a JavaScript source
// takes as values: a module whose exports all bindings that never change
// after initialization is a copy of those values, a module with a mutable
// export is the runtime's live namespace, and either way taking a namespace
// twice answers the one object Node answers for the module.
import { types } from "node:util";
import * as direct from "node:util/types";
import * as fixed from "./fixed.js";
import * as again from "./fixed.js";
import * as mutable from "./mutable.js";

const held = fixed;
console.log("direct", types.isModuleNamespaceObject(fixed));
console.log("reimport", types.isModuleNamespaceObject(again));
console.log("held", types.isModuleNamespaceObject(held));
console.log("same object", fixed === held, again === fixed);
console.log("keys", Object.keys(fixed).join(","));
console.log("direct spelling", direct.isModuleNamespaceObject(fixed));
console.log("mutable", types.isModuleNamespaceObject(mutable));
mutable.bump();
console.log("mutable after", types.isModuleNamespaceObject(mutable), mutable.counter);
console.log("object", types.isModuleNamespaceObject({}));
console.log("null prototype", types.isModuleNamespaceObject(Object.create(null)));
console.log("string", types.isModuleNamespaceObject("Module"));
console.log("null", types.isModuleNamespaceObject(null));
