// @normalize-pid
// Posting a port its own entangled other end answers true and reports
// Node's warning: the channel is lost.
import { MessageChannel } from "node:worker_threads";

const { port1, port2 } = new MessageChannel();
console.log("self", JSON.stringify(port1.postMessage("x", [port2])));
port1.close();
