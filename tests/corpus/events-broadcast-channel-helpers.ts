// The events helpers over a BroadcastChannel: it is an EventTarget, so
// getEventListeners, listenerCount, getMaxListeners, and setMaxListeners
// answer from its listener state, before and after close().
import { getEventListeners, getMaxListeners, listenerCount, setMaxListeners } from "node:events";
import { BroadcastChannel } from "node:worker_threads";

const channel = new BroadcastChannel("helpers");
const first = () => {};
const second = () => {};
channel.addEventListener("message", first);
channel.addEventListener("message", second);
channel.addEventListener("other", first);

const listeners = getEventListeners(channel, "message");
console.log("listeners", listeners.length, listeners[0] === first, listeners[1] === second);
console.log("other", getEventListeners(channel, "other").length);
console.log("none", getEventListeners(channel, "none").length);
console.log("symbol", getEventListeners(channel, Symbol("message")).length);
console.log("count", listenerCount(channel, "message"), listenerCount(channel, "other"));

console.log("max", getMaxListeners(channel));
setMaxListeners(4, channel);
console.log("max", getMaxListeners(channel));

channel.close();
console.log("closed", listenerCount(channel, "message"), getEventListeners(channel, "message").length);
channel.removeEventListener("message", first);
console.log("removed", listenerCount(channel, "message"));

// The onmessage attribute registers a wrapper function of its own.
const attributed = new BroadcastChannel("attributes");
const onMessage = () => {};
attributed.onmessage = onMessage;
const wrappers = getEventListeners(attributed, "message");
console.log("attribute", wrappers.length, wrappers[0] === onMessage);
attributed.onmessage = null;
console.log("cleared", listenerCount(attributed, "message"));
attributed.close();
