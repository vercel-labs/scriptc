// MessagePort.postMessage answers true on an open port; a closed port and a
// Worker answer undefined, as in Node. A null or undefined transfer list
// means none, an empty list is none, and a value that is no iterable answers
// Node's TypeError; a Worker's invalid transferList option is a
// DataCloneError instead. The declared type of postMessage is void (as in
// @types/node), so the runtime value is read through an untyped view.
import { MessageChannel, Worker, isMainThread, parentPort } from "node:worker_threads";

const raw = (value) => /** @type {any} */ (value);
const show = (label, fn) => {
  try {
    console.log(label, JSON.stringify(fn()));
  } catch (error) {
    console.log(label, error.name, error.code, JSON.stringify(error.message));
  }
};

if (isMainThread) {
  const open = new MessageChannel();
  console.log("open", JSON.stringify(raw(open.port1).postMessage("a")));
  const closed = new MessageChannel();
  closed.port1.close();
  console.log("closed", JSON.stringify(raw(closed.port1).postMessage("b")));
  show("null transfer", () => raw(open.port1).postMessage("c", null));
  show("undefined transfer", () => raw(open.port1).postMessage("d", undefined));
  show("empty object", () => raw(open.port1).postMessage("e", {}));
  show("empty array", () => raw(open.port1).postMessage("f", []));
  show("string transfer", () => raw(open.port1).postMessage("g", "x"));
  show("number transfer", () => raw(open.port1).postMessage("h", 42));
  show("object transfer non-iterable", () => raw(open.port1).postMessage("i", { transfer: 42 }));
  const worker = new Worker(new URL(import.meta.url));
  console.log("worker", JSON.stringify(raw(worker).postMessage("j")));
  show("worker transferList null", () => {
    const other = new Worker(new URL(import.meta.url), { transferList: null });
    other.terminate();
    return "created";
  });
  show("worker transferList string", () => {
    const other = new Worker(new URL(import.meta.url), { transferList: "x" });
    other.terminate();
    return "created";
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await worker.terminate();
  open.port1.close();
  open.port2.close();
  closed.port2.close();
} else {
  parentPort.on("message", () => {});
}
