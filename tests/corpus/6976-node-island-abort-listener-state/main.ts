// @requires-libnode
// Listeners of one abort on both sides of a Node island. Each side's
// listeners run in their registration order, and every listener, native or
// island, already sees `aborted` and the reason on both sides. (The order
// between a native and an island listener is the documented difference
// from Node and is not printed here; node-island-handles.test.ts pins it.)
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

const controller = new AbortController();
const signal = controller.signal;
const native: string[] = [];
const nativeState = (): string => `${signal.aborted}:${String(signal.reason)}`;

signal.addEventListener("abort", () => native.push(`n1:${nativeState()}:${lib.state(signal)}`));
lib.listen(signal, "i1", nativeState);
signal.addEventListener("abort", () => native.push(`n2:${nativeState()}:${lib.state(signal)}`));
lib.listen(signal, "i2", nativeState);
signal.addEventListener("abort", () => native.push(`n3:${nativeState()}:${lib.state(signal)}`), {
  once: true,
});
lib.listen(signal, "i3", nativeState);

controller.abort("now");
console.log("native", native.join(" "));
console.log("island", lib.order());

// Reactions to the abort are jobs of one queue: the island's promise
// reaction runs after the program's synchronous code, as under Node.
const second = new AbortController();
const reacted: Promise<void> = new Promise((resolve) => {
  lib.listen(second.signal, "late", () => {
    queueMicrotask(() => {
      console.log("microtask of the listener");
      resolve();
    });
    return "queued";
  });
});
second.abort("later");
console.log("after abort()");
reacted.then(() => console.log("island", lib.order().split(" ").pop()));
