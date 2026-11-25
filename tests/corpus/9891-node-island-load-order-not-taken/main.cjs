// @requires-libnode
// Island modules that share state and no file: one writes it when it loads
// (a global, a builtin prototype, `process`, an export or the private state
// of a module both use, the module registry), another reads it when it
// loads. Every writer here is written where this run does not load it. The
// build's probe loads each module once, in one process, writers included,
// so each reader's recorded load saw a write that Node never performs. A
// recorded load answers only in a run that registered, before it, the loads
// the probe evaluated before it; here the first reader finds a load
// missing and evaluates at its import, as Node does.
const never = process.argv.length > 99;

// A branch not taken.
if (never) require("state-kit/global-writer.js");
console.log("global:", require("state-kit/global-reader.js").level);

// A writer the build keeps eager, in a branch not taken.
if (never) require("state-kit/effect-writer.js");
console.log("global, eager writer:", require("state-kit/mode-reader.js").mode);

// The right operand of `&&`.
const skipped = never && require("state-kit/prototype-writer.js");
console.log("prototype:", skipped, require("state-kit/prototype-reader.js").word);

// An arm of `?:`.
const arm = never ? require("state-kit/process-writer.js").wrote : "the other arm";
console.log("process:", arm, require("state-kit/process-reader.js").mode);

// A module both use: its export, then its private state.
if (never) require("state-kit/export-writer.js");
console.log("another module's export:", require("state-kit/export-reader.js").mode);
if (never) require("state-kit/private-writer.js");
console.log("another module's private state:", require("state-kit/private-reader.js").count);

// The module registry.
if (never) require("state-kit/registry-writer.js");
console.log("module registry:", require("state-kit/registry-reader.js").which);

// State below a global's value: a property of `console`, and an element of
// a list that a load this run does perform put on a global.
if (never) require("state-kit/console-writer.js");
console.log("property of console:", require("state-kit/console-reader.js").level);
require("state-kit/list-maker.js");
if (never) require("state-kit/list-writer.js");
console.log("below a global's object:", require("state-kit/list-reader.js").count);

// A getter on the global object.
if (never) require("state-kit/getter-writer.js");
console.log("getter on the global object:", require("state-kit/getter-reader.js").got);
