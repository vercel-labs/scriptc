// @deferred-fences: 2
// The dd-trace shape: a module requires v8 at top level and touches its
// engine-observation members only on optional paths. Requiring it and
// destructuring members succeeds; getHeapStatistics answers.
const v8 = require("v8");
const { writeHeapSnapshot, setFlagsFromString } = require("node:v8");

console.log(typeof v8, typeof v8.getHeapStatistics);
const stats = v8.getHeapStatistics();
console.log(stats.heap_size_limit > 0, "used_heap_size" in stats);

function snapshot(enabled) {
  if (enabled) return writeHeapSnapshot();
  return "skipped";
}
console.log(snapshot(process.env.SCRIPTC_NEVER_SET === "1"));
if (process.env.SCRIPTC_NEVER_SET === "1") setFlagsFromString("--expose-gc");
console.log("done");
