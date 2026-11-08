// @requires-libnode
// Island modules that share state and no file, loaded by this run in
// another order than the build's probe takes. The probe places a load that
// only runs under a condition after the loads that always run, takes both
// branches of an `if` in the order they are written, and loads a module
// once however often a loop asks for it. A reader's recorded load is then not
// what this run computes: the writer loaded before it here and after it in
// the probe, or the other way round. A recorded load answers only in a run
// that registered, before it, the loads the probe evaluated before it; any
// other run evaluates the module at its import, as Node does.
const always = process.argv.length < 99;

// The right operand of `&&`, evaluated: the probe placed the writer last.
const viaAnd = always && require("state-kit/global-writer.js");
console.log("operand evaluated:", viaAnd.wrote, require("state-kit/global-reader.js").level);

// Each branch's module reads what the other's wrote, then writes; the run
// loads them in the order of the branch it takes, the probe in the order
// of the branch written first.
let first, second;
if (!always) {
  first = require("state-kit/both-a.js");
  second = require("state-kit/both-b.js");
} else {
  first = require("state-kit/both-b.js");
  second = require("state-kit/both-a.js");
}
console.log("branches that read each other:", first.saw, second.saw);
console.log("written last:", require("state-kit/last-reader.js").last);

// A loop that loads the writer, then a reader.
for (let i = 0; i < 2; i++) require("state-kit/process-writer.js");
console.log("loop:", require("state-kit/process-reader.js").mode);
