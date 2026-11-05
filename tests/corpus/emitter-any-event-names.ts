// EventEmitter calls whose event name is an arbitrary string (an event bus
// that forwards caller-chosen channels). Every name keeps Node's contract:
// 'error' with no listener throws, listeners registered under a literal
// name with typed parameters receive converted arguments, and off removes
// by the original listener.
import { EventEmitter } from "node:events";

interface Bus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
  clear(): void;
}

function createBus(emitter: EventEmitter): Bus {
  return {
    emit: (channel, data) => {
      emitter.emit(channel, data);
    },
    on: (channel, handler) => {
      const safe = async (data: unknown) => {
        try {
          await handler(data);
        } catch (err) {
          console.log(`handler error (${channel}):`, (err as Error).message);
        }
      };
      emitter.on(channel, safe);
      return () => {
        emitter.off(channel, safe);
      };
    },
    clear: () => {
      emitter.removeAllListeners();
    },
  };
}

const emitter = new EventEmitter();
const bus = createBus(emitter);
const off = bus.on("greet", (d) => console.log("greet", JSON.stringify(d)));
bus.on("greet", () => {
  throw new Error("boom");
});
bus.emit("greet", { who: "a" });
bus.emit("nobody", 1);
console.log("count", emitter.listenerCount("greet"));
off();
console.log("count after off", emitter.listenerCount("greet"));
bus.emit("greet", "after off");

// A listener registered under a literal name with a typed parameter.
emitter.on("count", (n: number) => console.log("typed count", n + 1));
bus.emit("count", 41);
// A literal-name typed emit reaches a listener registered by computed name.
bus.on("count", (d) => console.log("bus count", JSON.stringify(d)));
emitter.emit("count", 7);

// 'error' through a computed name: no listener throws the payload.
const errName = ["er", "ror"].join("");
try {
  bus.emit(errName, new Error("unhandled"));
} catch (e) {
  console.log("threw", (e as Error).message);
}
bus.on(errName, (e) => console.log("error listener", (e as Error).message));
bus.emit(errName, new Error("handled"));

bus.clear();
bus.emit("greet", "cleared");
console.log("names", emitter.eventNames().length);
// Prefixed and suffixed emits reach listeners registered by an
// unrestricted name.
const channels = new EventEmitter();
function listen(name: string): void {
  channels.on(name, (d: unknown) => console.log("channel", name, JSON.stringify(d)));
}
listen("user:1");
listen("job.done");
const userId = String(1);
const jobKind = ["jo", "b"].join("");
console.log("prefixed", channels.emit("user:" + userId, { a: 1 }));
console.log("suffixed", channels.emit(`${jobKind}.done`, 2));
console.log("unmatched", channels.emit("user:" + String(2), 3));
setTimeout(() => console.log("done"), 0);
