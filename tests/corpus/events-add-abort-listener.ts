// events.addAbortListener(signal, listener): the listener observes the
// signal's 'abort' event with the Event argument, the returned Disposable
// removes it (twice over is harmless), and an already-aborted signal never
// calls the listener. events.errorMonitor's listener runs before the
// 'error' listeners on every emit, and an 'error' emit with only a monitor
// listener is still unhandled: Node throws for it.
import { EventEmitter, addAbortListener, errorMonitor } from "node:events";

const controller = new AbortController();
const seen: string[] = [];
const disposable = addAbortListener(controller.signal, (event: Event) => {
  seen.push(`aborted ${event.type}`);
});
console.log("disposable", typeof disposable[Symbol.dispose]);
controller.abort("why");
console.log("seen", seen.join(" | "));
disposable[Symbol.dispose]();
disposable[Symbol.dispose]();
controller.abort("again");
console.log("after dispose", seen.join(" | "));

const aborted = new AbortController();
aborted.abort();
let called = false;
addAbortListener(aborted.signal, () => void (called = true));
console.log("pre-aborted", called);

const emitter = new EventEmitter();
const log: string[] = [];
emitter.on(errorMonitor, (error: Error) => void log.push(`monitor ${error.message}`));
emitter.on("error", (error: Error) => void log.push(`error ${error.message}`));
console.log("emit", emitter.emit("error", new Error("one")), emitter.emit("error", new Error("two")));
console.log(log.join(" | "));

const monitored = new EventEmitter();
monitored.on(errorMonitor, () => void log.push("monitor only"));
try {
  monitored.emit("error", new Error("unhandled"));
} catch (error) {
  const caught = error as Error & { code?: string };
  console.log("unhandled", caught.name, caught.code, caught.message);
}
console.log(log.join(" | "));
