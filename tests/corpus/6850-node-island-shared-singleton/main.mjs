// @requires-libnode
// A module both the program and a Node island import exists once (scope-B
// NI-6): island imports of the compiled `state.mjs` resolve to its live
// native exports, so a write on either side is seen by the other, and an
// exported `let` is a live binding in the island too.
import { requireModule } from "@scriptc/node";
import { config, count, entries, record, reset } from "./state.mjs";

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
