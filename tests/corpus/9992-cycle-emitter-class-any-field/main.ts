// An EventEmitter subclass of an import cycle, a named export, with fields
// held as checked-dynamic values (`any`, `any[]`). The relay module is
// evaluated first and reaches the class early, then later: the early reach
// is Node's ReferenceError, the later ones construct, listen and emit.
import { Station } from "./station.ts";
import { firstTry, open, summarize } from "./relay.ts";

const station = open("north");
station.on("signal", (strength: number) => console.log("signal", strength));
station.extra = { band: "fm" };
station.log.push("tuned", 3);
console.log(firstTry);
console.log(station.emit("signal", 4), summarize(station), station instanceof Station);
console.log(summarize(new Station("south")));
