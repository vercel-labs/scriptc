// os.homedir() with HOME unset and no passwd entry for the effective uid,
// not caught: the program must report the SystemError and exit 1, as Node
// does, rather than abort on a signal.
import * as os from "node:os";

console.log("before");
console.log(os.homedir());
console.log("after");
