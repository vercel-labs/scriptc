"use strict";
exports.onExit = () => process.on("exit", (code) => console.log(`island exit listener ${code}`));
exports.rejected = (m) => Promise.reject(new Error(m));
exports.tick = (label) => process.nextTick(() => console.log(`island tick ${label}`));
