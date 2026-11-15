// @requires-libnode
// Two deferred island packages. The program calls a function of the first,
// which writes island-global state, before it uses the second, whose top
// level reads that state once. Node evaluated both at their imports, before
// the call, so the second saw the state unwritten. Every deferred module
// evaluates when Node starts, in import order, before the first call runs:
// a module that waited for its own first use would see what the call wrote.
import { install, installed } from "patch-pkg";
import { captured, mode } from "reader-pkg";

console.log("start", typeof install, typeof mode);
install();
console.log("installed", typeof installed(), installed().name);
console.log("mode", mode());
console.log("captured", captured() === installed());
