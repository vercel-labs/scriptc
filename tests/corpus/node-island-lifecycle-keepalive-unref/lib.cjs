"use strict";
const log = (s) => console.log(s);
exports.unrefTimer = (ms) => setTimeout(() => log("NOT REACHED island unref timer"), ms).unref();
exports.refTimer = (ms, label) => setTimeout(() => log(`island timer ${label}`), ms);
exports.rerefTimer = (ms) => {
  const t = setTimeout(() => log("island re-ref'd timer"), ms);
  t.unref();
  t.ref();
};
let ticks = 0;
exports.unrefInterval = () => setInterval(() => ticks++, 5).unref();
exports.ticked = () => ticks > 0;
exports.unrefServer = () => {
  const s = require("node:net").createServer();
  s.listen(0, "127.0.0.1");
  s.unref();
};
