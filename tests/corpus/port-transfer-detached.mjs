// A transfer list refuses a port that is already detached: one transferred
// earlier, or one whose close() ran. A valid transfer answers true.
import { MessageChannel } from "node:worker_threads";

const { port1, port2 } = new MessageChannel();
const inner = new MessageChannel();
const show = (label, fn) => {
  try {
    console.log(label, JSON.stringify(fn()));
  } catch (error) {
    console.log(label, error.name, error.code, JSON.stringify(error.message));
  }
};
console.log("transfer", JSON.stringify(port2.postMessage({ port: inner.port1 }, [inner.port1])));
show("again", () => port2.postMessage("x", [inner.port1]));
const closedChannel = new MessageChannel();
closedChannel.port1.close();
show("closed", () => port2.postMessage("y", [closedChannel.port1]));
show("source", () => port1.postMessage("z", [port1]));
await new Promise((resolve) => setTimeout(resolve, 20));
port1.close();
port2.close();
closedChannel.port2.close();
inner.port2.close();
