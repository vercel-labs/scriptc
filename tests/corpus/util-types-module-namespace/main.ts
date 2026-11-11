// util.types.isModuleNamespaceObject answers for the module namespaces a
// program can hold: a constant-export namespace (a plain object copy in
// the compiled program) and a live namespace with a mutable export. Every
// other value — including objects that look like the namespace shape — is
// not a namespace object.
import { types } from "node:util";
import * as direct from "node:util/types";
import * as fixed from "./fixed.ts";
import * as mutable from "./mutable.ts";

mutable.bump();
console.log("mutable export", mutable.counter);
console.log("fixed namespace", types.isModuleNamespaceObject(fixed));
console.log("mutable namespace", types.isModuleNamespaceObject(mutable));
console.log("direct spelling", direct.isModuleNamespaceObject(fixed));
console.log("object", types.isModuleNamespaceObject({}));
console.log("array", types.isModuleNamespaceObject([1, 2]));
console.log("null prototype", types.isModuleNamespaceObject(Object.create(null)));
console.log("function", types.isModuleNamespaceObject(function named(): void {}));
console.log("string", types.isModuleNamespaceObject("Module"));
console.log("null", types.isModuleNamespaceObject(null));
console.log("undefined", types.isModuleNamespaceObject(undefined));
