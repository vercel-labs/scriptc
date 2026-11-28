// errorMonitor listeners run BEFORE the unhandled-'error' decision, and the
// decision reads the listeners they leave: one that installs an 'error'
// listener makes the emit handled, one that removes the last makes the
// payload throw, and one that throws keeps its own exception.
import { EventEmitter, errorMonitor } from "node:events";

const adds = new EventEmitter();
adds.on(errorMonitor, (err: Error) => {
  console.log("monitor adds", err.message);
  adds.on("error", (late: Error) => console.log("late handler", late.message));
});
console.log("emit adds", adds.emit("error", new Error("first")));

const removes = new EventEmitter();
removes.on("error", (err: Error) => console.log("handler must not run", err.message));
removes.on(errorMonitor, () => {
  console.log("monitor removes");
  removes.removeAllListeners("error");
});
try {
  removes.emit("error", new Error("second"));
} catch (err) {
  console.log("threw", (err as Error).message);
}

const throws = new EventEmitter();
throws.on(errorMonitor, () => {
  throw new Error("monitor owns this");
});
throws.on("error", (err: Error) => console.log("handler must not run", err.message));
try {
  throws.emit("error", new Error("ignored payload"));
} catch (err) {
  console.log("threw", (err as Error).message);
}

const bare = new EventEmitter();
bare.on(errorMonitor, (err: Error) => console.log("monitor bare", err.message));
try {
  bare.emit("error", new RangeError("payload"));
} catch (err) {
  console.log("threw", (err as Error).name, (err as Error).message);
}

// The untyped emit entry point makes the same decision; its monitors are
// registered through the typed surface on the same emitter.
const mixed = new EventEmitter();
const untyped: any = mixed;
mixed.on(errorMonitor, (err: Error) => {
  console.log("monitor untyped", err.message);
  mixed.on("error", (late: Error) => console.log("untyped late handler", late.message));
});
console.log("emit untyped", untyped.emit("error", new Error("third")));
mixed.removeAllListeners("error");
mixed.on(errorMonitor, () => {
  console.log("monitor untyped removes");
  mixed.removeAllListeners("error");
});
try {
  untyped.emit("error", new Error("fourth"));
} catch (err: any) {
  console.log("threw", err.message);
}
