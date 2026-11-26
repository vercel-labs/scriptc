/* A runtime string key reads the Module class's statics as the name itself
 * does: the key is evaluated once and matched against the statics the
 * compiled surface answers, and any other name answers undefined. Keys the
 * checker keeps as `any` keep the generic element-read behavior. */
const nodeModule = require("node:module");
const Module = nodeModule.Module;

function readLocalKey() {
  const key = "isBuiltin";
  return Module[key];
}
console.log(
  "local string",
  typeof readLocalKey(),
  readLocalKey() === nodeModule.isBuiltin,
  readLocalKey()("node:fs"),
);

for (const key of ["builtinModules", "constants", "nope"]) {
  const value = Module[key];
  console.log(
    "loop",
    key,
    typeof value,
    key === "builtinModules"
      ? value === nodeModule.builtinModules
      : key === "constants"
        ? value === nodeModule.constants
        : value === undefined,
  );
}
