// @normalize-pid
// The leak warning's `emitter` is the emitter itself: it answers the same
// value comparison as the program's own reference, and EventEmitter's own
// members work on it — the introspection forms, setMaxListeners (whose
// chaining value is the emitter), and registration/emit/removal through
// the shared listener table.
import { EventEmitter } from "node:events";

class Bus extends EventEmitter {}

function noop() {
  console.log("data fired");
}

const bus = new Bus();
bus.setMaxListeners(1);
process.on("warning", (warning) => {
  const em = warning.emitter;
  console.log("identity", em === bus);
  console.log("count", em.listenerCount("data"));
  console.log("names", JSON.stringify(em.eventNames()));
  console.log("max", em.getMaxListeners());
  console.log("set", em.setMaxListeners(3) === bus, em.getMaxListeners());
  const ping = (value) => console.log("ping", value);
  console.log("on", em.on("ping", ping) === bus, em.listenerCount("ping"));
  console.log("emit", em.emit("ping", 7));
  console.log("off", em.off("ping", ping) === bus, em.listenerCount("ping"));
  console.log("emit none", em.emit("ping"));
  console.log("wipe", em.removeAllListeners("data") === bus, em.listenerCount("data"));
});
bus.on("data", noop);
bus.on("data", noop);
bus.on("data", noop);
console.log("done", bus.listenerCount("data"));
