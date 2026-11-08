// @requires-libnode
// An island load written under a condition that holds, as the program's
// first island load. The build cannot tell whether a conditional load
// runs, and places it after the loads it is sure of when it probes; this
// run takes it, so the file it shares with a later load evaluates here,
// before the native module called next. Neither module may be deferred
// when the shared file's evaluation has effects, whichever of the two the
// build probed first.
const always = process.argv.length < 99;
const say = require("./between.cjs");

const taken = always && require("order-kit/taken-a.js");
say("after the taken load");
const takenKind = require("./dep-taken.cjs").kind;
console.log(typeof taken.a, takenKind);
