/* node:module's Module class carries the module surface as statics: each
 * one is the same value the namespace's export is. Reading them through the
 * class value — by name or by a literal computed key — answers that value;
 * an internal the compiled surface does not represent (createRequire,
 * findPackageJSON, _cache) stays undefined. */
const nodeModule = require("node:module");
const Module = nodeModule.Module;

console.log("class", Module.Module === Module, Module === nodeModule.Module);
console.log("isBuiltin", typeof Module.isBuiltin, Module.isBuiltin === nodeModule.isBuiltin, Module.isBuiltin("node:fs"));
console.log(
  "builtinModules",
  Module.builtinModules === nodeModule.builtinModules,
  Module.builtinModules.length,
  Object.isFrozen(Module.builtinModules),
);
console.log("constants", Module.constants === nodeModule.constants, JSON.stringify(Module.constants));
console.log(
  "compile cache",
  typeof Module.enableCompileCache,
  Module.enableCompileCache === nodeModule.enableCompileCache,
  typeof Module.flushCompileCache,
  typeof Module.getCompileCacheDir,
);
console.log(
  "sync",
  typeof Module.syncBuiltinESMExports,
  Module.syncBuiltinESMExports === nodeModule.syncBuiltinESMExports,
);
console.log(
  "computed",
  typeof Module["isBuiltin"],
  Module["builtinModules"] === nodeModule.builtinModules,
  Module["isBuiltin"]("node:fs"),
);
