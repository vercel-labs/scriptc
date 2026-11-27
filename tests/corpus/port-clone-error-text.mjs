// A value the clone cannot carry is named in Node's DataCloneError: the
// rendered value and " could not be cloned.", for a message, for workerData
// and for structuredClone alike.
import { Worker, MessageChannel, isMainThread } from "node:worker_threads";

if (isMainThread) {
  const show = (label, fn) => {
    try {
      fn();
      console.log(label, "no throw");
    } catch (error) {
      console.log(label, error.name, error.code, JSON.stringify(error.message));
    }
  };
  const { port1, port2 } = new MessageChannel();
  show("post function", () => port2.postMessage({ f: () => 1 }));
  show("post symbol", () => port2.postMessage(Symbol("s")));
  show("workerData function", () => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { f: () => 1 } });
    worker.terminate();
  });
  show("workerData symbol", () => {
    const worker = new Worker(new URL(import.meta.url), { workerData: Symbol("s") });
    worker.terminate();
  });
  show("clone function", () => structuredClone(() => 1));
  /* The uncloneable member is what stops the clone: Node renders that
   * member's source text, and the object's own conversions never run. */
  const conversions = {
    toString() {
      throw new Error("toString called");
    },
    valueOf() {
      throw new Error("valueOf called");
    },
  };
  show("post member function", () => port2.postMessage({ conversions }));
  show("clone member function", () => structuredClone({ conversions }));
  port1.close();
  port2.close();
}
