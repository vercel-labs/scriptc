/* A shadowed loader is the application's: `module.require("fs")` through a
 * parameter must call that loader and use what it returns, never the
 * builtin member dispatch. */
function readThrough(module) {
  return module.require("fs").readFileSync("/missing", "utf8");
}
console.log(
  "shadowed",
  readThrough({ require: (spec) => ({ readFileSync: (p, e) => "fake:" + spec + ":" + p + ":" + e }) }),
);

const local = { require: (spec) => ({ basename: (p) => "local:" + spec + ":" + p }) };
console.log("local", local.require("node:path").basename("/a/b"));

console.log("global", module.require("node:path").basename("/x/y.txt"));
