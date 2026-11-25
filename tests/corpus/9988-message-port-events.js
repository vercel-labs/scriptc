// MessagePort's EventTarget side: addEventListener('message') and the
// onmessage attribute deliver a MessageEvent, on('message') the raw value,
// a 'message' listener starts the port, a peer's close() delivers a 'close'
// Event, and the global MessageChannel/MessagePort values construct (or
// refuse) as Node's do.
import { MessageChannel as ModuleChannel, MessagePort as ModulePort } from "node:worker_threads";

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

const { port1, port2 } = new ModuleChannel();
port2.addEventListener("message", (event) => {
  console.log(
    "event",
    event.type,
    JSON.stringify(event.data),
    event.target === port2,
    event.currentTarget === port2,
    JSON.stringify(event.origin),
    JSON.stringify(event.lastEventId),
    event.source,
    Array.isArray(event.ports),
    event.ports.length,
  );
});
port1.postMessage({ n: 1 });
await tick();
port1.close();
port2.close();

const { port1: a, port2: b } = new ModuleChannel();
b.on("message", (value) => {
  console.log("on", typeof value, JSON.stringify(value));
});
a.postMessage("raw");
await tick();
a.close();
b.close();

const { port1: c, port2: d } = new ModuleChannel();
d.onmessage = (event) => {
  console.log("attribute", event.type, event.data, typeof d.onmessage);
};
c.postMessage("attr");
await tick();
c.close();
d.close();

const { port1: e, port2: f } = new ModuleChannel();
f.addEventListener("close", (event) => {
  console.log("close", event.type, JSON.stringify(event));
});
e.close();
await tick();
f.close();

const global = new MessageChannel();
global.port2.addEventListener("message", (event) => {
  console.log("global", event.type, JSON.stringify(event.data));
});
global.port1.postMessage("via global");
await tick();
global.port1.close();
global.port2.close();

const { port1: h1, port2: h2 } = new ModuleChannel();
let emitterValue = null;
h2.on("message", (value) => {
  emitterValue = value;
  value.seen = "emitter";
});
h2.addEventListener("message", (event) => {
  console.log("shared", event.data === emitterValue, event.data.seen);
});
h1.postMessage({ tag: 1 });
await tick();
h1.close();
h2.close();

const { port1: g1, port2: g2 } = new ModuleChannel();
g1.unref();
g2.unref();
const refs = [];
const track = (label) => refs.push(`${label}:${g2.hasRef()}`);
track("fresh");
const listener = () => {};
g2.onmessage = listener;
track("onmessage");
g2.onmessage = null;
track("cleared");
g2.addEventListener("message", listener);
track("added");
g2.removeEventListener("message", listener);
track("removed");
g2.on("message", listener);
track("on");
g2.removeListener("message", listener);
track("off");
console.log("refs", refs.join(" "));
g1.close();
g2.close();

console.log(
  "types",
  typeof ModuleChannel,
  typeof MessageChannel,
  typeof MessagePort,
  global.port1 instanceof EventTarget,
);
console.log("tag", Object.prototype.toString.call(global.port1));
try {
  new ModulePort();
  console.log("construct", "accepted");
} catch (error) {
  console.log("construct", error.name, error.code, error.message);
}
console.log("done");
