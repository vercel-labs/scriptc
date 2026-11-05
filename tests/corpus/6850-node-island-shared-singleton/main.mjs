// @requires-libnode
// A module both the program and a Node island import exists once (scope-B
// NI-6): island imports of the compiled `state.mjs` resolve to its live
// native exports, so a write on either side is seen by the other, and an
// exported `let` is a live binding in the island too.
import { requireModule } from "@scriptc/node";
import { config, count, entries, record, reset, describe, retitle } from "./state.mjs";
import { bumpTally, tally } from "./tally.mjs";

record("main-1");
console.log("main before island", count, entries());

const plugin = requireModule("./plugin.mjs");
console.log("island start:", plugin.startup);
console.log("main after island load", count, entries());

console.log("island report:", plugin.report());
record("main-2");
console.log("island report after main write:", plugin.report());
console.log("island bump:", plugin.bump("island-2"), "main sees", count);

plugin.configure("island-mode");
console.log("main sees config", config.mode, config.owner);
config.owner = "main";
console.log("island sees config", plugin.describeConfig());

console.log("same functions", plugin.sameRecord(record), plugin.requireSees());
reset();
console.log("after reset", count, entries(), plugin.report());

// A module loaded straight into Node is the program's own instance, and
// its members called as methods are the program's functions.
const direct = requireModule("./state.mjs");
const { record: directRecord, entries: directEntries } = direct;
directRecord("direct-1");
console.log("direct load", count, entries(), directEntries() === entries());
console.log("direct methods", direct.record("direct-2"), direct.record(String(count + 1)), direct.entries());
bumpTally();
const { bumpTally: islandBump } = requireModule("./tally.mjs");
console.log("tally", islandBump(), tally);

// A reassigned exported function declaration is a live binding too: the
// island sees the function the program installed.
console.log("describe", plugin.describeNow(), describe());
retitle();
console.log("retitled", plugin.describeNow(), describe());
