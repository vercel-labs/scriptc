import { Worker, isMainThread, parentPort } from "node:worker_threads";

if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  let reply = "";
  worker.on("message", (value: unknown) => { reply = JSON.stringify(value); });
  worker.on("exit", (code: number) => console.log(reply, "exit", code));
  // Delivery must survive posting before the worker has initialized.
  worker.postMessage(42);
} else {
  const port = parentPort!;
  port.start();
  const states: boolean[] = [port.hasRef()];
  const noop = () => {};
  port.ref();
  port.on("close", noop);
  port.off("close", noop);
  states.push(port.hasRef());
  port.on("message", noop);
  port.unref();
  port.on("message", noop);
  states.push(port.hasRef());
  port.removeAllListeners("message");
  port.ref();
  port.removeAllListeners("message");
  states.push(port.hasRef());
  port.unref();
  port.once("message", (value: unknown) => {
    states.push(port.hasRef());
    port.ref();
    states.push(port.hasRef());
    const post = port.postMessage;
    post.call(port, { states, value });
    port.close(() => {
      if (port.hasRef()) throw new Error("closed port retained its reference");
    });
  });
  states.push(port.hasRef());
}
