// A Worker's listener lists, as Node's EventEmitter answers them: listeners()
// holds the registered functions in order, rawListeners() the once() wrapper
// with its `listener` property, both are fresh arrays, and an event with no
// registration answers []. A MessagePort's NodeEventTarget has neither, nor
// the prepend* listeners a Worker does have.
import { Worker, MessageChannel, isMainThread, parentPort } from "node:worker_threads";

if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  const first = () => {};
  const second = () => {};
  worker.on("tick", first);
  worker.once("tick", second);
  const plain = worker.listeners("tick");
  const raw = worker.rawListeners("tick") as any[];
  console.log("plain", plain.length, plain[0] === first, plain[1] === second);
  console.log("raw", raw.length, raw[0] === first, raw[1] === second, raw[1].listener === second);
  console.log("empty", worker.listeners("missing").length);
  console.log("emit", worker.emit("missing"), "max", worker.getMaxListeners());
  plain.push(first);
  console.log("copy", worker.listeners("tick").length);
  console.log(
    "surface",
    typeof worker.listeners,
    typeof worker.rawListeners,
    typeof worker.emit,
    typeof worker.eventNames,
    typeof worker.getMaxListeners,
    typeof worker.setMaxListeners,
  );
  const { port1 } = new MessageChannel();
  const port = port1 as any;
  console.log("port", typeof port.listeners, typeof port.rawListeners, typeof port.prependListener);
  port1.close();
  worker.on("exit", () => console.log("exit"));
} else {
  parentPort!.postMessage("done");
}
