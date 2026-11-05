// @requires-libnode
// A class exported by a module both sides import is one class (scope-B
// NI-6): instances made on either side answer instanceof on both, keep
// their identity, and their methods run natively.
import { requireModule } from "@scriptc/node";
import { Point, describeAll, isPoint, make, remember, remembered } from "./shapes.mjs";

const island = requireModule("./island.mjs");

const native = new Point(3, 4);
console.log("island sees native instance:", island.check(native));
const fromIsland = island.create(6, 8);
console.log("native instanceof:", fromIsland instanceof Point, isPoint(fromIsland));
console.log("native reads:", fromIsland.x, fromIsland.y, fromIsland.norm());
console.log("island instanceof:", island.selfCheck());
console.log("plain object (island):", island.plainIsPoint());
console.log("plain object (native):", isPoint({ x: 1, y: 2 }));

remember(native);
console.log("kept:", island.keep(fromIsland), describeAll());
console.log("identity:", remembered(1) === fromIsland, island.firstIsNative(native));
console.log("made by native factory in island:", island.viaFactory());
console.log("class identity:", island.sameClass(Point), island.sameClass(make));
