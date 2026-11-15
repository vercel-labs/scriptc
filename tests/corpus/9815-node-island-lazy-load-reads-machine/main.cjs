// @requires-libnode
// A package the project marks `"evaluate": "lazy"`: the build defers its
// load whatever it does. What the load read of the machine must still be
// the run's: the snapshot of such a load holds no constants (it once did
// for every read but the clock's, and the executable carried the build
// machine's time zone and host name), so the first read of a value starts
// Node and evaluates the module.
const os = require("os");
const kit = require("lazy-kit");

console.log("function:", typeof kit.describe);
console.log("midnight:", kit.midnight, "zone:", kit.zone);
console.log("host:", kit.host === os.hostname(), "parallel:", kit.parallel === os.availableParallelism());
console.log("name:", kit.name, kit.describe());
