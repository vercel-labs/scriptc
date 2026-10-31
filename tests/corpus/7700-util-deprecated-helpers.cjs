// util.isArray and util._extend, the deprecated helpers: Node's answers
// (_extend assigns from the last own key to the first and leaves
// non-object sources alone), and DEP0044/DEP0060 once each on the next
// tick, shared with util.deprecate's codes. The program re-runs itself and
// prints the child's output with process ids normalized.
"use strict";
const { spawnSync } = require("node:child_process");
const util = require("util");
function child() {
  process.on("warning", (w) => console.log("listener", w.name, w.code));
  console.log(util.isArray([1]), util.isArray("x"), util.isArray({ length: 0 }), util.isArray());
  console.log(util._extend({ a: 1 }, { b: 2, c: 3 }));
  console.log(Object.keys(util._extend({}, { x: 1, y: 2, z: 3 })));
  console.log(util._extend({ a: 1 }, null), util._extend({ a: 1 }, "str"), util._extend({ a: 1 }, () => 1));
  console.log(util._extend([0], [5, 6]), util._extend({ k: 1 }));
  const t = { keep: true };
  console.log(util._extend(t, { keep: false }) === t, t);
  try { util._extend(null, { a: 1 }); } catch (e) { console.log(e.name, e.message); }
  console.log(util._extend(null, {}));
  util.isArray([]);
  const dep = util.deprecate(() => "wrapped", "a custom DEP0060", "DEP0060");
  console.log(dep(), "sync end");
}
if (process.argv[2] === "child") child();
else {
  const run = spawnSync(process.execPath, [process.argv[1], "child"], { encoding: "utf8" });
  console.log(`status: ${run.status}`);
  console.log(run.stdout);
  console.log(run.stderr.replace(/\(node:\d+\)/g, "(node:<pid>)"));
}
