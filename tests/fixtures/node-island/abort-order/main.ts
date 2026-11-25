// The one difference from Node when a native AbortSignal is shared with a
// Node island (node-island-handles.test.ts pins it; docs: limitations,
// "Abort listeners across native code and islands"). Under Node this is one
// signal with one listener list: the listeners below run n1, i1, n2, i2 and
// every count is the total. Here each side keeps its own list: the island's
// listeners run first, then the program's, and each side counts its own.
import { getEventListeners } from "node:events";
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const controller = new AbortController();
const signal = controller.signal;

signal.addEventListener("abort", () => console.log("n1"));
const afterFirst: number = lib.listen(signal, "i1");
signal.addEventListener("abort", () => console.log("n2"));
const afterSecond: number = lib.listen(signal, "i2");
console.log("island counts", afterFirst, afterSecond, "native count", getEventListeners(signal, "abort").length);
controller.abort();
