import { freemem, loadavg, totalmem } from "node:os";

const free = freemem();
const total = totalmem();
const load = loadavg();

console.log("freemem > 0:", free > 0);
console.log("freemem <= totalmem:", free <= total);
console.log("loadavg length:", Array.isArray(load), load.length === 3);
console.log("loadavg elements >= 0:", load[0]! >= 0, load[1]! >= 0, load[2]! >= 0);
