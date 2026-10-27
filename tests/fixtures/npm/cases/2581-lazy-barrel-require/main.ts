// The lazy barrel (gtlazy) required from CommonJS: require() hands out the
// export object itself, so each re-export's getter runs at its read. A
// module initializes at the first read of one of its exports, once, and
// later reads see its live bindings (greet reassigns GREETING).
import { first, again } from "gtlazyuser";

console.log("main start");
console.log(first());
console.log(again());
