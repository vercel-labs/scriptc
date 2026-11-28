// @exit: 1
// With a signal, a thrown value whose message read throws leaves the request
// pending (Node's rejection handler throws before rejecting) and reports the
// trap's error as an unhandled rejection, which ends the process.
import { locks } from "node:worker_threads";
const trap = new Proxy({}, { get() { throw new Error("trap get"); } });
const controller = new AbortController();
try {
  await locks.request("signal-proxy", { signal: controller.signal }, () => {
    throw trap;
  });
  console.log("resolved");
} catch (error) {
  console.log("rejected", error.message);
}
