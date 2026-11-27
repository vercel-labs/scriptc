/* The module object's own `require` is an ordinary member: writing it (here
   by a literal computed key) makes `module.require(...)` call the
   replacement, as Node does — the canonical loader is not run. */
const fake = (id) => ({ basename: (p) => `fake:${id}:${p}` });
module["require"] = fake;
console.log(module.require("node:path").basename("/a/b"));
console.log(module.require("node:os").basename("/c"));
const stored = module.require("node:fs");
console.log(stored.basename("/d"));
module["require"] = function (id) {
  const self = this;
  return { basename: (p) => `${self === module ? "mod" : "other"}:${id}:${p}` };
};
console.log(module.require("node:path").basename("/e"));
