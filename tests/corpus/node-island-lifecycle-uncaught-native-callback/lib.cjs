"use strict";
exports.onExit = () => process.on("exit", (code) => console.log(`island exit listener ${code}`));
exports.later = (ms, fn) => setTimeout(fn, ms);
exports.emitter = () => new (require("node:events").EventEmitter)();
