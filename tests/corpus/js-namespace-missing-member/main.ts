// A module namespace object is an ordinary object at run time: a name the
// module does not export reads undefined. Only an import of the missing name
// is a load-time error. Shipped JavaScript probes a package's dev-only
// members exactly this way (react-dom's startup copies `Scheduler.log`,
// which React's production scheduler does not export, behind a typeof test).
import * as lib from "./lib.ts";

console.log(typeof (lib as any).log);
console.log((lib as any).missing);
console.log(typeof (lib as any).now);
console.log(lib.now(), lib.later());
console.log(Object.keys(lib).join());
