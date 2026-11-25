// The EventEmitter surface the documentation describes: the chaining
// registration methods and their order (prepend and once included), emit's
// boolean result and argument passing, listenerCount with and without the
// listener, eventNames over strings and symbols, off/removeListener,
// removeAllListeners by name and for every name, the 'newListener' and
// 'removeListener' meta events, errorMonitor ahead of an 'error' listener
// and Node's throw for an unhandled 'error', setMaxListeners/getMaxListeners
// chains, `this` bound to the emitter, listener registration and removal
// during an emit, and a subclass constructed by super().
import EE, { EventEmitter, errorMonitor } from "node:events";

const emitter = new EventEmitter();
const order: string[] = [];
const onA = (x: number): void => void order.push(`onA ${x}`);
const onB = (x: number): void => void order.push(`onB ${x}`);
const onceC = (x: number): void => void order.push(`onceC ${x}`);
const prepended = (x: number): void => void order.push(`pre ${x}`);
const prependedOnce = (x: number): void => void order.push(`preOnce ${x}`);
console.log("addListener", emitter.addListener("go", onA) === emitter);
console.log("on", emitter.on("go", onB) === emitter);
console.log("prependListener", emitter.prependListener("go", prepended) === emitter);
console.log("once", emitter.once("go", onceC) === emitter);
console.log("prependOnceListener", emitter.prependOnceListener("go", prependedOnce) === emitter);
console.log("emit 1", emitter.emit("go", 1));
console.log("emit 2", emitter.emit("go", 2));
console.log(order.join(" | "));
console.log("listenerCount", emitter.listenerCount("go"), emitter.listenerCount("go", onA));
console.log("eventNames", emitter.eventNames().join(","));
console.log("unheard", emitter.emit("nobody"), emitter.emit("nobody"));
console.log("off", emitter.off("go", onA) === emitter);
console.log("removeListener", emitter.removeListener("go", onB) === emitter);
console.log("count after remove", emitter.listenerCount("go"));
emitter.emit("go", 3);
console.log("removeAllListeners name", emitter.removeAllListeners("go") === emitter);
console.log("empty", emitter.listenerCount("go"), emitter.eventNames().length);

const symbolic = new EventEmitter();
const key = Symbol("key");
console.log("symbol on", symbolic.on(key, (x: number) => console.log("symbol", x)) === symbolic);
console.log("symbol emit", symbolic.emit(key, 7), symbolic.listenerCount(key), symbolic.eventNames().length);
console.log("symbol once", symbolic.once(key, () => {}) === symbolic);
symbolic.removeAllListeners();
console.log("symbol cleared", symbolic.eventNames().length);

const meta = new EventEmitter();
const metaLog: string[] = [];
meta.on("newListener", (name: string) => void metaLog.push(`new ${name}`));
meta.on("removeListener", (name: string) => void metaLog.push(`remove ${name}`));
const shared = (): void => {};
meta.on("evt", shared);
meta.once("evt", shared);
meta.removeListener("evt", shared);
meta.removeAllListeners("evt");
console.log(metaLog.join(" | "));

const monitored = new EventEmitter();
const monitorLog: string[] = [];
monitored.on(errorMonitor, (error: Error) => void monitorLog.push(`monitor ${error.message}`));
monitored.on("error", (error: Error) => void monitorLog.push(`error ${error.message}`));
console.log("emit error", monitored.emit("error", new Error("one")), monitored.emit("error", new Error("two")));
console.log(monitorLog.join(" | "));
const unhandled = new EventEmitter();
unhandled.on(errorMonitor, () => void monitorLog.push("monitor only"));
try {
  unhandled.emit("error", new Error("unhandled"));
} catch (error) {
  const caught = error as Error & { code?: string };
  console.log("unhandled", caught.name, caught.code, caught.message);
}

const limits = new EventEmitter();
console.log("max chain", limits.setMaxListeners(7) === limits, limits.getMaxListeners(), EE.defaultMaxListeners);
limits.setMaxListeners(0);
console.log("zero max", limits.getMaxListeners());

const owner = new EventEmitter();
const bound = function (this: EventEmitter): void {
  console.log("this", this === owner);
};
owner.on("bound", bound);
owner.emit("bound");

const mutated = new EventEmitter();
const mutationLog: string[] = [];
const late = (value: number): void => void mutationLog.push(`late ${value}`);
const second = (value: number): void => void mutationLog.push(`second ${value}`);
const first = (value: number): void => {
  mutationLog.push(`first ${value}`);
  mutated.on("m", late);
};
mutated.on("m", first);
mutated.on("m", second);
mutated.emit("m", 1);
mutated.emit("m", 2);
console.log(mutationLog.join(" | "));

const removable = new EventEmitter();
const removalLog: string[] = [];
const victim = (): void => void removalLog.push("victim");
removable.on("r", victim);
removable.on("r", () => {
  removalLog.push("remover");
  removable.removeListener("r", victim);
});
removable.on("r", () => void removalLog.push("after"));
removable.emit("r");
removable.emit("r");
console.log(removalLog.join(" | "));

const throwing = new EventEmitter();
let afterThrow = 0;
throwing.on("t", () => {
  throw new Error("listener boom");
});
throwing.on("t", () => void afterThrow++);
try {
  throwing.emit("t");
} catch (error) {
  console.log("threw", (error as Error).message, afterThrow);
}

class Bus extends EventEmitter {
  constructor() {
    super();
    this.on("ready", () => console.log("bus ready"));
  }
}
const bus = new Bus();
bus.emit("ready");
console.log("instanceof", bus instanceof EventEmitter);
