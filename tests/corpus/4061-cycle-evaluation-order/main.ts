// Side effects across a three-module cycle run in ES evaluation order:
// the depth-first walk from main reaches north → east → south, and south's
// import of north is answered from the module cache, so the bodies run
// south, east, north, then main. Each body calls into the others.
import { north, log } from "./north.ts";

log("main body");
console.log(north(3));
console.log(log("done"));
