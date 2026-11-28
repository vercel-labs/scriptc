// The void-declared result keeps Node's value: the binding holds the true a
// MessagePort's postMessage answers, so it compares false with undefined and
// true with true.
import { MessageChannel } from "node:worker_threads";

const port = new MessageChannel().port1;
const again = port.postMessage("x");
console.log("compared undefined", again === undefined);
console.log("compared true", again === true);
port.close();
