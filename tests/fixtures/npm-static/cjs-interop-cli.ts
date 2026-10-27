// npm-static pilots: real CommonJS packages that preflight refused before.
// fs.realpath@1.0.0 and on-finished@2.4.1 assign module.exports and run
// code before they require their dependencies (each binding is reachable
// only after its require ran); statuses@2.0.1 requires its codes.json.
import realpath from "fs.realpath";
import onFinished from "on-finished";
import status from "statuses";

console.log(typeof realpath.realpathSync, typeof onFinished, typeof status);
