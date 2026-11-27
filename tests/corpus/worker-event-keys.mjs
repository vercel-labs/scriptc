// A Worker's event keys follow property-key conversion, as Node's
// EventEmitter does: a symbol stays a symbol key, and a number or an object
// becomes its string form, for registration, emit, counts and lists alike.
import { Worker, isMainThread } from "node:worker_threads";

if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  const sym = Symbol("tick");
  let fired = 0;
  const counter = () => {
    fired++;
  };
  console.log(
    "on symbol",
    worker.on(sym, counter) === worker,
    worker.listenerCount(sym),
    worker.eventNames().includes(sym),
  );
  console.log("emit symbol", worker.emit(sym), fired);
  console.log("once symbol", worker.once(Symbol.for("once"), counter) === worker);
  console.log(
    "on number",
    worker.on(7, counter) === worker,
    worker.listenerCount(7),
    worker.eventNames().includes("7"),
  );
  console.log("emit number", worker.emit(7), fired);
  const key = { toString: () => "objKey" };
  console.log(
    "on object",
    worker.on(key, counter) === worker,
    worker.listenerCount(key),
    worker.emit({ toString: () => "objKey" }),
    fired,
  );
  console.log("off symbol", worker.off(sym, counter) === worker, worker.listenerCount(sym));
  console.log(
    "removeAll symbol",
    worker.removeAllListeners(Symbol.for("once")) === worker,
    worker.eventNames().includes(Symbol.for("once")),
  );
  await worker.terminate();
}
