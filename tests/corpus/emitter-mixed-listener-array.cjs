const { EventEmitter } = require("node:events");
const e = new EventEmitter();
e.on("c", (n) => console.log("typed", n + 1));
e.on(process.argv[2] ?? "c", (v) => console.log("dyn", typeof v));
const ls = e.listeners("c");
console.log("len", ls.length);
ls.forEach((f) => { try { f(41); } catch (x) { console.log("threw", x.name); } });
console.log("done");
