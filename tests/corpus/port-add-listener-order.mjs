// addEventListener follows the DOM order: the options are read first, an
// already-aborted signal returns before the event name is looked at, and the
// type is converted once after that — so a getter that changes the name's
// string form decides the registered type.
import { MessageChannel } from "node:worker_threads";

const { port1 } = new MessageChannel();
const abortedController = new AbortController();
abortedController.abort();
let abortedCalls = 0;
const abortedName = {
  toString() {
    abortedCalls++;
    return "aborted";
  },
};
port1.addEventListener(abortedName, () => {}, { signal: abortedController.signal });
console.log("aborted calls", abortedCalls, port1.listenerCount("aborted"));
let captureRead = false;
let convertCalls = 0;
const mutableName = {
  toString() {
    convertCalls++;
    return captureRead ? "second" : "first";
  },
};
port1.addEventListener(
  mutableName,
  () => {},
  {
    get capture() {
      captureRead = true;
      return false;
    },
  },
);
console.log("renamed", captureRead, convertCalls, port1.listenerCount("first"), port1.listenerCount("second"));
console.log("names", port1.eventNames().map(String).join(","));
port1.close();
