/* module.builtinModules is ONE frozen array in Node: every spelling answers
 * the same object, Object.isFrozen is true, and it is the pinned Node v24
 * list (sorted, with the four prefix-only ids). */
import * as nodeModule from "node:module";
import { builtinModules } from "node:module";

console.log("length", builtinModules.length);
console.log("frozen", Object.isFrozen(builtinModules), Array.isArray(builtinModules));
console.log("identity", builtinModules === nodeModule.builtinModules);
console.log(
  "sorted",
  JSON.stringify([...builtinModules].sort()) === JSON.stringify(builtinModules),
);
console.log(
  "prefix-only",
  JSON.stringify(builtinModules.filter((name) => name.startsWith("node:"))),
);
console.log(
  "members",
  builtinModules.includes("fs"),
  builtinModules.includes("node:fs"),
  builtinModules.includes("node:test"),
  builtinModules.includes("test"),
  new Set(builtinModules).size === builtinModules.length,
);

const boxed: any = nodeModule;
console.log("boxed", typeof boxed.builtinModules, boxed.builtinModules === builtinModules);
