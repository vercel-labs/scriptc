// @requires-libnode
// An island load written in the condition of an `if`. The condition always
// runs, and it runs before the branch and before everything after the
// statement, so what its module leaves in shared state when it loads is
// there for the island modules that load later. The build records each
// deferred module's snapshot in one probe process, in the order the program
// evaluates the loads: a condition's load probed after the others gave the
// later modules snapshots computed without it, and the program read values
// Node never produces.

// The branch is taken: level-kit reads at its load what flag-kit set at its.
if (require("flag-kit").flag) {
  const kit = require("level-kit");
  console.log("taken:", kit.level, kit.seen);
}

// The branch is not taken: report-kit, loaded after the statement, reads
// what mode-kit set at its load.
if (require("mode-kit").strict) {
  console.log("not reached");
}
const report = require("report-kit");
console.log("after:", report.mode, report.count);

// A condition with no island load, and an else branch: unchanged.
if (process.argv.length > 99) {
  console.log("not reached either");
} else {
  console.log("else:", require("level-kit").level, require("report-kit").mode);
}
