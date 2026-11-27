// The messageerror surface: a port's onmessageerror property holds the
// listener Node assigns to it, and a Worker answers 'messageerror' as an
// emitter event. Normal traffic never fires either, as in Node: a message is
// produced and read by the same encoder.
import { MessageChannel } from "node:worker_threads";

const { port1, port2 } = new MessageChannel();
const listener = (event: any) => console.log("messageerror", event.type);
port1.onmessageerror = listener;
console.log("port onmessageerror", typeof port1.onmessageerror);
port1.addEventListener("messageerror", listener);
port1.onmessage = (event: any) => console.log("port message", JSON.stringify(event.data));
port2.postMessage({ ok: true });
await new Promise((resolve) => setTimeout(resolve, 10));
port2.close();
port1.close();
