"use strict";
const log = (s) => console.log(s);
const kept = new Map();
exports.on = (event, label) => {
  const fn = (...a) => log(`island ${label} ${event} ${a.map((x) => (x instanceof Error ? x.message : typeof x === "object" && x !== null ? x.constructor.name : String(x))).join(" ")}`);
  kept.set(`${event}:${label}`, fn);
  process.on(event, fn);
};
exports.off = (event, label) => process.removeListener(event, kept.get(`${event}:${label}`));
exports.once = (event, label) => process.once(event, (...a) => log(`island ${label} ${event} ${a.map((x) => (x instanceof Error ? x.message : String(x))).join(" ")}`));
exports.onCb = (event, fn) => process.on(event, fn);
exports.throwLater = (ms, m) => setTimeout(() => { throw new Error(m); }, ms);
exports.rejectLater = (ms, m) => setTimeout(() => { Promise.reject(new Error(m)); }, ms);
exports.rejected = (m) => Promise.reject(new Error(m));
exports.throwNow = (m) => { throw new Error(m); };
exports.timer = (ms, label) => setTimeout(() => log(`island timer ${label}`), ms);
exports.timerCb = (ms, fn) => setTimeout(fn, ms);
exports.exit = (code) => process.exit(code);
exports.setExitCode = (code) => { process.exitCode = code; };
exports.getExitCode = () => process.exitCode;
exports.callLater = (ms, fn) => setTimeout(() => fn(), ms);
exports.call = (fn) => fn();
exports.kill = (sig) => process.kill(process.pid, sig);
exports.log = log;

