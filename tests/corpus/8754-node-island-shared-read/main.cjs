// @requires-libnode
// Two island modules share a file that reads something of the process it
// runs in (here the path of its executable) and has no effects. The build
// evaluates the file once, in the load it probes first, in the build's own
// process; the other module's exports hold the value all the same. Neither
// module's exports are constants of the program: this run reads the value
// through the first module before Node has any other reason to start, and
// it is the running process's, the same the second module reports.
const always = process.argv.length < 99;
const first = always && require("host-kit/a.js");
const before = first.exec;
const second = require("./dep.cjs").exec;
console.log("same executable:", before === second, typeof before);
