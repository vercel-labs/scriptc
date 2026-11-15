// @requires-libnode
// Island loads written under a condition. The build probes island modules
// in the order they are written, as a run in which every condition holds
// would reach them, and the probe evaluates a file two modules share in
// the load it reaches first. A run that skips that load evaluates the file
// in the other module's load, so neither module may be deferred when the
// file's evaluation has effects: here each shared file prints, and Node
// prints it where the first load the run really reaches is.
const never = process.argv.length > 99;
const label = never ? null : "set";
const say = require("./between.cjs");

// Skipped loads, in every form that evaluates only part of what it holds.
const viaAnd = never && require("order-kit/skipped-a.js");
const viaOr = !never || require("order-kit/skipped-a.js");
const viaNullish = label ?? require("order-kit/skipped-a.js");
const viaChoice = never ? require("order-kit/skipped-a.js") : "other arm";
const viaOptional = globalThis.nothingCalledThis?.(require("order-kit/skipped-a.js"));
say("after the skipped loads");
const skippedKind = require("./dep-skipped.cjs").kind;
console.log(viaAnd, viaOr, viaNullish, viaChoice, viaOptional, skippedKind);

// A load behind a condition that holds: the shared file evaluates there.
const taken = !never && require("order-kit/taken-a.js");
say("after the taken load");
const takenKind = require("./dep-taken.cjs").kind;
console.log(typeof taken.a, takenKind);

// A branch the run does not take.
let branch = "not taken";
if (never) branch = typeof require("order-kit/branch-a.js").a;
say("after the branch");
const branchKind = require("./dep-branch.cjs").kind;
console.log(branch, branchKind);

// A module that returns before its load.
require("./early.cjs");
say("after the module that returns early");
const returnedKind = require("./dep-returned.cjs").kind;
console.log(returnedKind);
