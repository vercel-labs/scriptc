/* A shadowed loader is not the CommonJS global: its `module.require` is
 * called even when the specifier names a package configured as a Node
 * island. The island is not loaded. */
function through(module) {
  return module.require("shadow-pkg");
}
console.log("shadowed", through({ require: (spec) => "loader:" + spec }));
