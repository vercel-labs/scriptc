// Ports whose listeners capture the port itself are cycles: the collector
// reclaims them mid-run, and the listener order a port kept (its allocation
// and the event names it retained) is released on that path too, so the
// reference audit at exit stays clean.
import { MessageChannel } from "node:worker_threads";

for (let i = 0; i < 40; i++) {
  const { port1, port2 } = new MessageChannel();
  const cycle = () => port1;
  port1.on("alpha" + i, cycle);
  port1.on("beta" + i, cycle);
  port1.addEventListener("gamma" + i, cycle);
  port1.close();
  port2.close();
}
const junk = [];
for (let i = 0; i < 200000; i++) junk.push({ i });
console.log("churn", junk.length);
