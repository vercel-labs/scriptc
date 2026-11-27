/* The module object's own `require` is an ordinary member: writing it (here
   by a literal computed key) makes `module.require(...)` call the
   replacement, as Node does — the canonical loader is not run. */
const fake = (id) => ({ basename: (p) => `fake:${id}:${p}` });
module["require"] = fake;
console.log(module.require("node:path").basename("/a/b"));
console.log(module.require("node:os").basename("/c"));
