// process.cwd stored as a value from CommonJS: the same function as the
// process module's member, read when it is called.
const processModule = require("node:process");
const get = process.cwd;
console.log(get === processModule.cwd, get.name, get() === process.cwd());
const { cwd } = processModule;
console.log(cwd === get, typeof cwd());
