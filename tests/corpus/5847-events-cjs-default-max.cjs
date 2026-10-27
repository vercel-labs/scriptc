// CommonJS bindings of node:events read defaultMaxListeners from the module
// object, which is the EventEmitter class: every read sees the current
// default.
const events = require("node:events");
const { EventEmitter, setMaxListeners } = require("node:events");
console.log(events.defaultMaxListeners, EventEmitter.defaultMaxListeners);
setMaxListeners(15);
console.log(events.defaultMaxListeners, EventEmitter.defaultMaxListeners, require("events").defaultMaxListeners);
events.defaultMaxListeners = 4;
console.log(events.defaultMaxListeners, EventEmitter.defaultMaxListeners, new EventEmitter().getMaxListeners());
