// crypto.secureHeapUsed(): a compiled binary is never started with
// --secure-heap, so Node's answer is the empty usage report — a fresh plain
// object whose keys come in Node's order.
import { secureHeapUsed } from "node:crypto";

const usage = secureHeapUsed();
console.log(JSON.stringify(usage));
console.log(Object.keys(usage).join(","));
console.log(usage.total, usage.used, usage.utilization, usage.min);
console.log(typeof usage.total, usage.utilization === null, usage.min === 2);
console.log(secureHeapUsed() !== usage);
