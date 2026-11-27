// An island reading a compiled class's accessor: each read crosses a fresh
// byte view back to V8. The accessor's own entry is what ends the young
// views after it, so the peak resident set stays flat as the reads grow;
// without that entry every returned chunk stays rooted in both heaps.
// Usage: accessor-views <reads>
import { requireModule } from "@scriptc/node";
import { Sink } from "./shapes.mjs";

const island = requireModule("./island.mjs");
const reads = Number(process.argv[2] ?? "1000");
const sink = new Sink();
const sum = island.drain(sink, reads);
const made = island.make();
const last = made.chunk.length;
console.log("sum", sum, "reads", sink.reads, "made", made.reads, last);
console.error(`peak rss ${island.peakRss()} KiB`);
