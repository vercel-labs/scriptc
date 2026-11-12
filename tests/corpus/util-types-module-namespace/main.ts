// util.types.isModuleNamespaceObject answers Node's [[Module]] brand: true
// for `import * as` bindings (program modules and node: builtins alike), a
// constant holding one, an awaited import(), and a program namespace that
// escaped into an untyped slot; false for the builtin sub-module members
// (util.types is Node's CommonJS exports object), plain objects, arrays and
// class instances, and the other brands answer false for a namespace. Asked
// through util.types, the named import and node:util/types alike. A
// namespace with a constant export set and a live one (a mutable export)
// both carry the brand.
import * as util from "node:util";
import { types } from "node:util";
import * as direct from "node:util/types";
import * as path from "node:path";
import * as mod from "./mod.ts";
import * as fixed from "./fixed.ts";
import * as mutable from "./mutable.ts";

console.log(
  "bindings",
  util.types.isModuleNamespaceObject(mod),
  types.isModuleNamespaceObject(path),
  direct.isModuleNamespaceObject(direct),
  types.isModuleNamespaceObject(util),
);
console.log("other brands", types.isDate(mod), types.isNativeError(path), types.isMap(mod));

const held = mod;
console.log("held", types.isModuleNamespaceObject(held));

const dynamic = await import("./mod.ts");
console.log(
  "dynamic",
  types.isModuleNamespaceObject(dynamic),
  types.isModuleNamespaceObject(await import("./mod.ts")),
  dynamic.beta(),
);

console.log("submodule member", types.isModuleNamespaceObject(util.types));

console.log("copy namespace", types.isModuleNamespaceObject(fixed), fixed.answer, fixed.double(21));
mutable.bump();
console.log("live namespace", types.isModuleNamespaceObject(mutable), mutable.counter);

const escaped: unknown = mod;
const escapedDynamic: unknown = await import("./mod.ts");
console.log(
  "escaped",
  types.isModuleNamespaceObject(escaped),
  types.isModuleNamespaceObject(escapedDynamic),
  types.isDate(escaped),
);

class Box {
  value = 1;
}
const plains: unknown[] = [{}, [], new Box(), "ns", 3, null, undefined, Math, JSON];
console.log("others", plains.map((value) => types.isModuleNamespaceObject(value)).join(" "));

const stored = types.isModuleNamespaceObject;
console.log("stored", stored({}), stored(escaped));

let order = "";
console.log(
  "effects",
  types.isModuleNamespaceObject(((order += "a"), mod)),
  order,
  mod.alpha,
);
