"use strict";
const { EventEmitter } = require("node:events");
exports.bus = new EventEmitter();
exports.emitLater = (bus, name, v) => process.nextTick(() => bus.emit(name, v));
exports.emitInMicrotask = (bus, name, v) => queueMicrotask(() => bus.emit(name, v));
exports.emitInTimer = (bus, name, v) => setTimeout(() => bus.emit(name, v), 1);
exports.listen = (bus, name, native) => {
  bus.on(name, (v) => {
    console.log(`island listener ${name} ${v}`);
    if (v > 0) native(v - 1);
  });
};
