// @requires-libnode
// Re-entrant emits on an island EventEmitter: a native listener emits on
// the same emitter from inside the emit, listeners are added and removed
// during an emit, and the emits start from a tick, a microtask and a timer.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const { bus } = lib;
const log = (s) => console.log(s);

bus.on("ping", (v) => {
  log(`native listener ping ${v}`);
  if (v > 0) bus.emit("ping", v - 1);
  log(`native listener ping ${v} returns`);
});
lib.listen(bus, "pong", (v) => {
  log(`native callback from island listener ${v}`);
  bus.emit("pong", v);
});
bus.emit("ping", 3);
bus.emit("pong", 3);

const first = () => {
  log("first: removes itself and adds third");
  bus.off("mut", first);
  bus.on("mut", third);
};
const second = () => log("second");
const third = () => log("third");
bus.on("mut", first);
bus.on("mut", second);
bus.emit("mut");
bus.emit("mut");
log(`listeners ${bus.listenerCount("mut")}`);

bus.once("late", (v) => {
  log(`late ${v}`);
  bus.once("late", (w) => {
    log(`late ${w}`);
    bus.once("late", (x) => log(`late ${x}`));
  });
});
lib.emitLater(bus, "late", "from tick");
lib.emitInMicrotask(bus, "late", "from microtask");
lib.emitInTimer(bus, "late", "from timer");

bus.on("error", (e) => log(`error listener ${e.message}`));
bus.emit("error", new Error("emitted error"));
bus.on("throws", () => {
  throw new Error("listener threw");
});
try {
  bus.emit("throws");
} catch (e) {
  log(`emit threw ${e.message}`);
}
log("main end");
