// The MessageEvent and CloseEvent globals: their init dictionaries (data,
// origin, lastEventId, source and ports; code, reason, wasClean), the
// member getters, the class tags, empty JSON bodies, and Node's constructor
// errors for a missing type or a bad port.
const message = new MessageEvent("ping", {
  data: { a: 1 },
  origin: "https://x",
  lastEventId: "7",
  ports: [],
});
console.log(
  "message",
  message.type,
  JSON.stringify(message.data),
  message.origin,
  message.lastEventId,
  message.source,
  Array.isArray(message.ports),
  message.bubbles,
  message.cancelable,
  message.composed,
);
console.log("message tag", Object.prototype.toString.call(message), JSON.stringify(message));
console.log("event strings", String(message), String(new Event("go")), Object.prototype.toString.call(new Event("go")));

const close = new CloseEvent("close", {
  code: 1001,
  reason: "bye",
  wasClean: true,
  cancelable: true,
});
console.log(
  "instance",
  message instanceof Event,
  message instanceof MessageEvent,
  close instanceof Event,
  close instanceof CloseEvent,
  new CustomEvent("c") instanceof MessageEvent,
);
console.log("types", typeof MessageEvent, typeof CloseEvent, typeof message);
console.log(
  "close",
  close.type,
  close.code,
  close.reason,
  close.wasClean,
  close.cancelable,
  Object.prototype.toString.call(close),
  JSON.stringify(close),
);
console.log(
  "close codes",
  new CloseEvent("x", { code: -1 }).code,
  new CloseEvent("x", { code: 1.5 }).code,
  new CloseEvent("x", { code: 70000 }).code,
  new CloseEvent("x", { code: "12" }).code,
  new CloseEvent("x", { wasClean: 1 }).wasClean,
  new CloseEvent("x").code,
);

console.log(
  "nulls",
  JSON.stringify(new MessageEvent("x", { origin: null }).origin),
  JSON.stringify(new MessageEvent("x", { lastEventId: null }).lastEventId),
  JSON.stringify(new MessageEvent("x", {}).origin),
  JSON.stringify(new CloseEvent("x", { reason: null }).reason),
  JSON.stringify(new CloseEvent("x").reason),
);

const target = new EventTarget();
target.addEventListener("x", (event) => {
  console.log("dispatched", event.type, event instanceof CloseEvent);
});
console.log("dispatch", target.dispatchEvent(new CloseEvent("x")));

const channel = new MessageChannel();
const initPorts = [channel.port1];
const holder = new MessageEvent("ports", { ports: initPorts });
initPorts.push(channel.port2);
const plain = new MessageEvent("empty");
console.log(
  "ports",
  holder.ports.length,
  holder.ports === holder.ports,
  Object.isFrozen(holder.ports),
  plain.ports.length,
  plain.ports === plain.ports,
  Object.isFrozen(plain.ports),
);
const withSource = new MessageEvent("source", { source: channel.port1 });
console.log("source", withSource.source === channel.port1, new MessageEvent("n").source === null);
channel.port1.close();
channel.port2.close();

const failures = [
  ["message missing", () => new MessageEvent()],
  ["close missing", () => new CloseEvent()],
  ["ports", () => new MessageEvent("x", { ports: 5 })],
  ["source", () => new MessageEvent("x", { source: 5 })],
];
for (const [label, make] of failures) {
  try {
    make();
    console.log(label, "accepted");
  } catch (error) {
    console.log(label, error.name, error.message);
  }
}
