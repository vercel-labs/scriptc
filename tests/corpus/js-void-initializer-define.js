// @define: process.env.VOID_INITIALIZER_MODE="fast"
"use strict";
// A file the build rewrites twice: the branch `--define` decides is resolved,
// and the `void 0` declarators around it hold what is written later.
function plan(steps) {
  var mode = void 0;
  if (process.env.VOID_INITIALIZER_MODE === "fast") {
    var limit = void 0;
    limit = steps.length > 2 ? 2 : steps.length;
    mode = { name: "fast", limit: limit };
  } else {
    var every = void 0;
    every = steps.slice();
    mode = { name: "full", limit: every.length };
  }
  let done = void 0;
  for (const step of steps.slice(0, mode.limit)) done = (done === void 0 ? "" : done + ",") + step;
  return mode.name + ":" + done;
}
console.log(plan(["a", "b", "c"]));
console.log(plan(["x"]));
console.log(plan([]));
