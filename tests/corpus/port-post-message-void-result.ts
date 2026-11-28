// TypeScript's `void` says a value is not meant to be used, not that it is
// undefined: MessagePort.postMessage answers true in Node, and a typed
// binding keeps that runtime value, so comparing it with undefined is false
// and nothing throws.
import { MessageChannel } from "node:worker_threads";

const port = new MessageChannel().port1;
const again = port.postMessage("x");
let threw = false;
let compared = true;
try {
  compared = again === undefined;
} catch {
  threw = true;
}
console.log("threw", threw, "compared", compared);
port.close();
