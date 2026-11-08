"use strict";
const log = (s) => console.log(s);
exports.onBeforeExit = (fn) => process.on("beforeExit", fn);
exports.listen = (label) => process.on("beforeExit", (code) => log(`island ${label} beforeExit code=${code}`));
exports.onExit = () => process.on("exit", (code) => log(`island exit ${code}`));
exports.count = () => process.listenerCount("beforeExit");
exports.timer = (ms, label) => setTimeout(() => log(label), ms);
